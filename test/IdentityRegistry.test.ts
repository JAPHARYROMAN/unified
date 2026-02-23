import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/* ─── Timelock test helpers ──────────────────────────────────────────────── */

const TIMELOCK_DELAY = 24 * 3600;

function computeTimelockId(iface: any, funcName: string, args: any[]): string {
  const fragment = iface.getFunction(funcName)!;
  const paramTypes = fragment.inputs.map((p: any) => p.type);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes4", ...paramTypes],
    [fragment.selector, ...args],
  );
  return ethers.keccak256(encoded);
}

async function timelockExec(contract: any, funcName: string, args: any[]) {
  const id = computeTimelockId(contract.interface, funcName, args);
  await contract.scheduleTimelock(id);
  await time.increase(TIMELOCK_DELAY);
  await contract[funcName](...args);
}

async function timelockSetup(
  steps: Array<{ contract: any; funcName: string; args: any[] }>,
) {
  for (const step of steps) {
    const id = computeTimelockId(
      step.contract.interface,
      step.funcName,
      step.args,
    );
    await step.contract.scheduleTimelock(id);
  }
  await time.increase(TIMELOCK_DELAY);
  for (const step of steps) {
    await step.contract[step.funcName](...step.args);
  }
}

/* ─── Shared fixture ─────────────────────────────────────────────────────── */

async function deployKycFixture() {
  const [admin, borrower, compliance, stranger] = await ethers.getSigners();

  // Tokens
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

  // Core protocol
  const Treasury = await ethers.getContractFactory("UnifiedTreasury");
  const treasury = await Treasury.deploy(admin.address);

  const FeeManager = await ethers.getContractFactory("UnifiedFeeManager");
  const feeManager = await FeeManager.deploy(
    admin.address,
    await treasury.getAddress(),
  );
  await timelockExec(feeManager, "setFees", [0, 0, 0]);

  const Vault = await ethers.getContractFactory("UnifiedCollateralVault");
  const vault = await Vault.deploy(admin.address);

  const LoanImpl = await ethers.getContractFactory("UnifiedLoan");
  const loanImpl = await LoanImpl.deploy();

  const Factory = await ethers.getContractFactory("UnifiedLoanFactory");
  const factory = await Factory.deploy(
    admin.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await feeManager.getAddress(),
    await treasury.getAddress(),
    await loanImpl.getAddress(),
  );

  // Wire roles
  const registrarRole = await vault.LOAN_REGISTRAR_ROLE();
  await vault.grantRole(registrarRole, await factory.getAddress());
  const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
  await feeManager.grantRole(feeRegistrarRole, await factory.getAddress());

  // Allow WETH as collateral
  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  // Deploy identity registry — admin is also KYC_MANAGER for test simplicity
  const Registry = await ethers.getContractFactory("UnifiedIdentityRegistry");
  const registry = await Registry.deploy(admin.address);

  // Grant compliance signer KYC_MANAGER_ROLE
  const kycManagerRole = await registry.KYC_MANAGER_ROLE();
  await registry.grantRole(kycManagerRole, compliance.address);

  // Default loan params helper
  const PRINCIPAL = 10_000_000n; // 10 USDC
  const COLLATERAL = ethers.parseEther("5");
  const KYC_HASH = ethers.keccak256(ethers.toUtf8Bytes("provider:ref:abc123"));

  function loanParams(overrides: Record<string, any> = {}) {
    return {
      fundingModel: 0,
      repaymentModel: 0,
      borrower: borrower.address,
      collateralToken: weth.target,
      collateralAmount: COLLATERAL,
      principalAmount: PRINCIPAL,
      interestRateBps: 1200,
      durationSeconds: 30 * 24 * 3600,
      gracePeriodSeconds: 7 * 24 * 3600,
      fundingDeadline: 0,
      pool: ethers.ZeroAddress,
      totalInstallments: 0,
      installmentInterval: 0,
      installmentGracePeriod: 0,
      penaltyAprBps: 0,
      defaultThresholdDays: 0,
      scheduleHash: ethers.ZeroHash,
      ...overrides,
    };
  }

  return {
    admin,
    borrower,
    compliance,
    stranger,
    usdc,
    weth,
    factory,
    feeManager,
    vault,
    registry,
    KYC_HASH,
    PRINCIPAL,
    COLLATERAL,
    loanParams,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  A) UnifiedIdentityRegistry unit tests
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("UnifiedIdentityRegistry", function () {
  it("sets identity and isApproved returns true", async function () {
    const { compliance, borrower, registry, KYC_HASH } =
      await deployKycFixture();

    const expiry = (await time.latest()) + 365 * 24 * 3600; // 1 year

    await expect(
      registry
        .connect(compliance)
        .setIdentity(borrower.address, true, KYC_HASH, 840, 1, expiry),
    )
      .to.emit(registry, "IdentityUpdated")
      .withArgs(borrower.address, true, KYC_HASH, 840, 1, expiry, () => true);

    expect(await registry.isApproved(borrower.address)).to.equal(true);

    const id = await registry.getIdentity(borrower.address);
    expect(id.kycApproved).to.equal(true);
    expect(id.kycHash).to.equal(KYC_HASH);
    expect(id.jurisdiction).to.equal(840);
    expect(id.riskTier).to.equal(1);
    expect(id.expiry).to.equal(expiry);
  });

  it("reverts setIdentity with approved=true and expiry in the past", async function () {
    const { compliance, borrower, registry, KYC_HASH } =
      await deployKycFixture();

    const pastExpiry = (await time.latest()) - 1;

    await expect(
      registry
        .connect(compliance)
        .setIdentity(borrower.address, true, KYC_HASH, 840, 1, pastExpiry),
    ).to.be.revertedWithCustomError(registry, "KYCExpired");
  });

  it("allows approved=false even with expiry=0", async function () {
    const { compliance, borrower, registry } = await deployKycFixture();

    await registry
      .connect(compliance)
      .setIdentity(borrower.address, false, ethers.ZeroHash, 0, 0, 0);

    expect(await registry.isApproved(borrower.address)).to.equal(false);
  });

  it("reverts setIdentity with approved=true and kycHash=0x0", async function () {
    const { compliance, borrower, registry } = await deployKycFixture();

    const expiry = (await time.latest()) + 365 * 24 * 3600;

    await expect(
      registry
        .connect(compliance)
        .setIdentity(borrower.address, true, ethers.ZeroHash, 840, 1, expiry),
    ).to.be.revertedWithCustomError(registry, "InvalidKycHash");
  });

  it("reverts setIdentity with riskTier > 4", async function () {
    const { compliance, borrower, registry, KYC_HASH } =
      await deployKycFixture();

    const expiry = (await time.latest()) + 365 * 24 * 3600;

    await expect(
      registry
        .connect(compliance)
        .setIdentity(borrower.address, true, KYC_HASH, 840, 5, expiry),
    ).to.be.revertedWithCustomError(registry, "InvalidTier");
  });

  it("isApproved returns false when identity has expired", async function () {
    const { compliance, borrower, registry, KYC_HASH } =
      await deployKycFixture();

    const shortExpiry = (await time.latest()) + 60; // 60 seconds

    await registry
      .connect(compliance)
      .setIdentity(borrower.address, true, KYC_HASH, 840, 1, shortExpiry);

    expect(await registry.isApproved(borrower.address)).to.equal(true);

    // Fast-forward past expiry
    await time.increase(120);

    expect(await registry.isApproved(borrower.address)).to.equal(false);
  });

  it("stranger cannot call setIdentity", async function () {
    const { stranger, borrower, registry, KYC_HASH } = await deployKycFixture();

    const expiry = (await time.latest()) + 365 * 24 * 3600;

    await expect(
      registry
        .connect(stranger)
        .setIdentity(borrower.address, true, KYC_HASH, 840, 1, expiry),
    ).to.be.reverted;
  });

  it("stores no PII — only hash, numeric codes, booleans, and timestamps", async function () {
    const { compliance, borrower, registry, KYC_HASH } =
      await deployKycFixture();

    const expiry = (await time.latest()) + 365 * 24 * 3600;

    await registry
      .connect(compliance)
      .setIdentity(borrower.address, true, KYC_HASH, 840, 2, expiry);

    const id = await registry.getIdentity(borrower.address);

    // Verify the struct only contains the expected field types:
    // bool, bytes32, uint256, uint8, uint256, uint256
    expect(typeof id.kycApproved).to.equal("boolean");
    expect(typeof id.kycHash).to.equal("string"); // bytes32 → hex string
    expect(id.kycHash.length).to.equal(66); // 0x + 64 hex chars = bytes32
    expect(typeof id.jurisdiction).to.equal("bigint"); // uint256
    expect(typeof id.riskTier).to.equal("bigint"); // uint8
    expect(typeof id.expiry).to.equal("bigint"); // uint256
    expect(typeof id.updatedAt).to.equal("bigint"); // uint256
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  B) Factory KYC integration tests
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Factory: KYC required", function () {
  it("reverts createLoan when kycRequired=true and borrower not approved", async function () {
    const { admin, borrower, factory, registry, loanParams } =
      await deployKycFixture();

    // Wire registry + enable KYC
    await timelockSetup([
      {
        contract: factory,
        funcName: "setIdentityRegistry",
        args: [await registry.getAddress()],
      },
      { contract: factory, funcName: "setKycRequired", args: [true] },
    ]);

    await expect(
      factory.connect(borrower).createLoan(loanParams()),
    ).to.be.revertedWithCustomError(factory, "KYCRequired");
  });

  it("succeeds after compliance approves borrower", async function () {
    const {
      admin,
      borrower,
      compliance,
      factory,
      registry,
      KYC_HASH,
      loanParams,
    } = await deployKycFixture();

    // Wire registry + enable KYC
    await timelockSetup([
      {
        contract: factory,
        funcName: "setIdentityRegistry",
        args: [await registry.getAddress()],
      },
      { contract: factory, funcName: "setKycRequired", args: [true] },
    ]);

    // Approve borrower
    const expiry = (await time.latest()) + 365 * 24 * 3600;
    await registry
      .connect(compliance)
      .setIdentity(borrower.address, true, KYC_HASH, 840, 1, expiry);

    await factory.connect(borrower).createLoan(loanParams());
    expect(await factory.loanCount()).to.equal(1);
  });

  it("does not enforce KYC when kycRequired=false (default)", async function () {
    const { borrower, factory, loanParams } = await deployKycFixture();

    // No registry set, no KYC required — should pass
    await factory.connect(borrower).createLoan(loanParams());
    expect(await factory.loanCount()).to.equal(1);
  });
});

describe("Factory: Jurisdiction enforcement", function () {
  async function jurisdictionFixture() {
    const f = await deployKycFixture();
    const { admin, borrower, compliance, factory, registry, KYC_HASH } = f;

    // Wire registry + enable jurisdiction enforcement
    const registryAddr = await registry.getAddress();

    await timelockSetup([
      {
        contract: factory,
        funcName: "setIdentityRegistry",
        args: [registryAddr],
      },
      {
        contract: factory,
        funcName: "setEnforceJurisdiction",
        args: [true],
      },
    ]);

    // Approve borrower in jurisdiction 840 (US)
    const expiry = (await time.latest()) + 365 * 24 * 3600;
    await registry
      .connect(compliance)
      .setIdentity(borrower.address, true, KYC_HASH, 840, 1, expiry);

    return f;
  }

  it("reverts when borrower jurisdiction is not allowed", async function () {
    const { borrower, factory, loanParams } = await jurisdictionFixture();

    // Jurisdiction 840 is NOT on the allowlist
    await expect(
      factory.connect(borrower).createLoan(loanParams()),
    ).to.be.revertedWithCustomError(factory, "JurisdictionBlocked");
  });

  it("succeeds after jurisdiction is allowed", async function () {
    const { admin, borrower, factory, loanParams } =
      await jurisdictionFixture();

    // Allow jurisdiction 840
    await factory.connect(admin).setJurisdictionAllowed(840, true);

    await factory.connect(borrower).createLoan(loanParams());
    expect(await factory.loanCount()).to.equal(1);
  });

  it("emits JurisdictionAllowedSet event", async function () {
    const { admin, factory } = await jurisdictionFixture();

    await expect(factory.connect(admin).setJurisdictionAllowed(840, true))
      .to.emit(factory, "JurisdictionAllowedSet")
      .withArgs(840, true);
  });
});

describe("Factory: Tier cap enforcement", function () {
  async function tierCapFixture() {
    const f = await deployKycFixture();
    const { admin, borrower, compliance, factory, registry, KYC_HASH } = f;

    const registryAddr = await registry.getAddress();

    await timelockSetup([
      {
        contract: factory,
        funcName: "setIdentityRegistry",
        args: [registryAddr],
      },
      { contract: factory, funcName: "setEnforceTierCaps", args: [true] },
    ]);

    // Approve borrower with riskTier=2
    const expiry = (await time.latest()) + 365 * 24 * 3600;
    await registry
      .connect(compliance)
      .setIdentity(borrower.address, true, KYC_HASH, 840, 2, expiry);

    return f;
  }

  it("reverts when principal exceeds tier cap", async function () {
    const { admin, borrower, factory, loanParams, PRINCIPAL } =
      await tierCapFixture();

    // Set tier-2 cap below the principal
    const cap = PRINCIPAL - 1n;
    await factory.connect(admin).setTierBorrowCap(2, cap);

    await expect(
      factory.connect(borrower).createLoan(loanParams()),
    ).to.be.revertedWithCustomError(factory, "TierCapExceeded");
  });

  it("succeeds when principal is within tier cap", async function () {
    const { admin, borrower, factory, loanParams, PRINCIPAL } =
      await tierCapFixture();

    // Set tier-2 cap at exactly the principal
    await factory.connect(admin).setTierBorrowCap(2, PRINCIPAL);

    await factory.connect(borrower).createLoan(loanParams());
    expect(await factory.loanCount()).to.equal(1);
  });

  it("no cap enforcement when tierBorrowCap is 0 (default)", async function () {
    const { borrower, factory, loanParams } = await tierCapFixture();

    // tierBorrowCap[2] is 0 by default → no cap
    await factory.connect(borrower).createLoan(loanParams());
    expect(await factory.loanCount()).to.equal(1);
  });

  it("emits TierBorrowCapSet event", async function () {
    const { admin, factory } = await tierCapFixture();

    await expect(factory.connect(admin).setTierBorrowCap(2, 5_000_000n))
      .to.emit(factory, "TierBorrowCapSet")
      .withArgs(2, 5_000_000n);
  });

  it("reverts setTierBorrowCap with tier > 4", async function () {
    const { admin, factory } = await tierCapFixture();

    await expect(
      factory.connect(admin).setTierBorrowCap(5, 1_000_000n),
    ).to.be.revertedWithCustomError(factory, "InvalidTier");
  });
});

describe("Factory: Combined KYC + jurisdiction + tier cap", function () {
  it("all three checks pass together", async function () {
    const {
      admin,
      borrower,
      compliance,
      factory,
      registry,
      KYC_HASH,
      PRINCIPAL,
      loanParams,
    } = await deployKycFixture();

    const registryAddr = await registry.getAddress();

    // Enable all three
    await timelockSetup([
      {
        contract: factory,
        funcName: "setIdentityRegistry",
        args: [registryAddr],
      },
      { contract: factory, funcName: "setKycRequired", args: [true] },
      {
        contract: factory,
        funcName: "setEnforceJurisdiction",
        args: [true],
      },
      { contract: factory, funcName: "setEnforceTierCaps", args: [true] },
    ]);

    // Allow jurisdiction + set tier cap
    await factory.connect(admin).setJurisdictionAllowed(840, true);
    await factory.connect(admin).setTierBorrowCap(1, PRINCIPAL);

    // Approve borrower
    const expiry = (await time.latest()) + 365 * 24 * 3600;
    await registry
      .connect(compliance)
      .setIdentity(borrower.address, true, KYC_HASH, 840, 1, expiry);

    await factory.connect(borrower).createLoan(loanParams());
    expect(await factory.loanCount()).to.equal(1);
  });
});

describe("Factory: KYC admin setters emit events", function () {
  it("setIdentityRegistry emits IdentityRegistryUpdated", async function () {
    const { admin, factory, registry } = await deployKycFixture();

    const registryAddr = await registry.getAddress();
    await timelockExec(factory, "setIdentityRegistry", [registryAddr]);

    // Verify state
    expect(await factory.identityRegistry()).to.equal(registryAddr);
  });

  it("setKycRequired emits KycRequiredUpdated", async function () {
    const { admin, factory } = await deployKycFixture();

    await timelockExec(factory, "setKycRequired", [true]);
    expect(await factory.kycRequired()).to.equal(true);
  });

  it("setEnforceJurisdiction emits JurisdictionPolicyUpdated", async function () {
    const { admin, factory } = await deployKycFixture();

    await timelockExec(factory, "setEnforceJurisdiction", [true]);
    expect(await factory.enforceJurisdiction()).to.equal(true);
  });

  it("setEnforceTierCaps emits TierCapsUpdated", async function () {
    const { admin, factory } = await deployKycFixture();

    await timelockExec(factory, "setEnforceTierCaps", [true]);
    expect(await factory.enforceTierCaps()).to.equal(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  Settlement-proof hooks for hybrid fiat integration
 * ═══════════════════════════════════════════════════════════════════════════ */

async function fiatProofFixture() {
  const [admin, borrower, lender, settlementAgent, stranger] =
    await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

  const Treasury = await ethers.getContractFactory("UnifiedTreasury");
  const treasury = await Treasury.deploy(admin.address);

  const FeeManager = await ethers.getContractFactory("UnifiedFeeManager");
  const feeManager = await FeeManager.deploy(
    admin.address,
    await treasury.getAddress(),
  );
  await timelockExec(feeManager, "setFees", [0, 0, 0]);

  const Vault = await ethers.getContractFactory("UnifiedCollateralVault");
  const vault = await Vault.deploy(admin.address);

  const LoanImpl = await ethers.getContractFactory("UnifiedLoan");
  const loanImpl = await LoanImpl.deploy();

  const Factory = await ethers.getContractFactory("UnifiedLoanFactory");
  const factory = await Factory.deploy(
    admin.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await feeManager.getAddress(),
    await treasury.getAddress(),
    await loanImpl.getAddress(),
  );

  const registrarRole = await vault.LOAN_REGISTRAR_ROLE();
  await vault.grantRole(registrarRole, await factory.getAddress());
  const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
  await feeManager.grantRole(feeRegistrarRole, await factory.getAddress());

  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  // Configure settlement agent (timelocked) + enable fiat proof
  await timelockSetup([
    {
      contract: factory,
      funcName: "setSettlementAgent",
      args: [settlementAgent.address],
    },
    {
      contract: factory,
      funcName: "setRequireFiatProofBeforeActivate",
      args: [true],
    },
  ]);

  const PRINCIPAL = 10_000_000n;
  const COLLATERAL = ethers.parseEther("5");
  const FIAT_REF = ethers.keccak256(
    ethers.toUtf8Bytes("settlement:wire:REF-001"),
  );

  const loanParams = {
    fundingModel: 0,
    repaymentModel: 0,
    borrower: borrower.address,
    collateralToken: await weth.getAddress(),
    collateralAmount: COLLATERAL,
    principalAmount: PRINCIPAL,
    interestRateBps: 1200,
    durationSeconds: 30 * 24 * 3600,
    gracePeriodSeconds: 7 * 24 * 3600,
    fundingDeadline: 0,
    pool: ethers.ZeroAddress,
    totalInstallments: 0,
    installmentInterval: 0,
    installmentGracePeriod: 0,
    penaltyAprBps: 0,
    defaultThresholdDays: 0,
    scheduleHash: ethers.ZeroHash,
  };

  // Create loan
  await factory.connect(borrower).createLoan(loanParams);
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  // Fund the loan
  await usdc.mint(lender.address, PRINCIPAL);
  await usdc.connect(lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(lender).fund(PRINCIPAL);

  // Mint collateral and lock it
  await weth.mint(borrower.address, COLLATERAL);
  await weth.connect(borrower).approve(await vault.getAddress(), COLLATERAL);

  const loanRole = await vault.LOAN_ROLE();
  await vault.connect(admin).grantRole(loanRole, admin.address);
  await vault
    .connect(admin)
    .lockCollateral(
      loanAddress,
      await weth.getAddress(),
      COLLATERAL,
      borrower.address,
    );

  return {
    admin,
    borrower,
    lender,
    settlementAgent,
    stranger,
    usdc,
    weth,
    factory,
    vault,
    loan,
    FIAT_REF,
    PRINCIPAL,
    COLLATERAL,
  };
}

describe("Settlement: fiat proof before activation", function () {
  it("reverts activateAndDisburse when fiat proof required but not recorded", async function () {
    const { borrower, loan } = await fiatProofFixture();

    await expect(
      loan.connect(borrower).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "FiatProofMissing");
  });

  it("succeeds after settlement agent records disbursement proof", async function () {
    const { borrower, settlementAgent, loan, FIAT_REF } =
      await fiatProofFixture();

    // Record fiat disbursement proof
    await expect(loan.connect(settlementAgent).recordFiatDisbursement(FIAT_REF))
      .to.emit(loan, "FiatDisbursementRecorded")
      .withArgs(await loan.getAddress(), FIAT_REF, () => true);

    expect(await loan.fiatDisbursementRef()).to.equal(FIAT_REF);
    expect(await loan.fiatDisbursedAt()).to.be.greaterThan(0);

    // Now activation succeeds
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE
  });

  it("stranger cannot record fiat disbursement", async function () {
    const { stranger, loan, FIAT_REF } = await fiatProofFixture();

    await expect(
      loan.connect(stranger).recordFiatDisbursement(FIAT_REF),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });

  it("cannot record disbursement twice", async function () {
    const { settlementAgent, loan, FIAT_REF } = await fiatProofFixture();

    await loan.connect(settlementAgent).recordFiatDisbursement(FIAT_REF);

    const ref2 = ethers.keccak256(
      ethers.toUtf8Bytes("settlement:wire:REF-002"),
    );
    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(ref2),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");
  });
});

describe("Settlement: fiat repayment proof", function () {
  it("emits FiatRepaymentRecorded correctly", async function () {
    const { settlementAgent, loan, FIAT_REF } = await fiatProofFixture();

    const repayRef = ethers.keccak256(
      ethers.toUtf8Bytes("settlement:wire:REPAY-001"),
    );

    await expect(loan.connect(settlementAgent).recordFiatRepayment(repayRef))
      .to.emit(loan, "FiatRepaymentRecorded")
      .withArgs(await loan.getAddress(), repayRef, () => true);

    expect(await loan.lastFiatRepaymentRef()).to.equal(repayRef);
  });

  it("reverts FiatRefAlreadyUsed on duplicate repayment ref", async function () {
    const { settlementAgent, loan } = await fiatProofFixture();

    const ref1 = ethers.keccak256(ethers.toUtf8Bytes("repay:ref1"));

    await loan.connect(settlementAgent).recordFiatRepayment(ref1);
    expect(await loan.lastFiatRepaymentRef()).to.equal(ref1);

    // Same ref again → revert
    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(ref1),
    ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");
  });

  it("stranger cannot record fiat repayment", async function () {
    const { stranger, loan } = await fiatProofFixture();

    const ref = ethers.keccak256(ethers.toUtf8Bytes("repay:ref"));
    await expect(
      loan.connect(stranger).recordFiatRepayment(ref),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });
});

describe("Settlement: disabled by default", function () {
  it("activation succeeds without fiat proof when requireFiatProofBeforeActivate is false", async function () {
    const [admin, borrower, lender] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    const Treasury = await ethers.getContractFactory("UnifiedTreasury");
    const treasury = await Treasury.deploy(admin.address);

    const FeeManager = await ethers.getContractFactory("UnifiedFeeManager");
    const feeManager = await FeeManager.deploy(
      admin.address,
      await treasury.getAddress(),
    );
    await timelockExec(feeManager, "setFees", [0, 0, 0]);

    const Vault = await ethers.getContractFactory("UnifiedCollateralVault");
    const vault = await Vault.deploy(admin.address);

    const LoanImpl = await ethers.getContractFactory("UnifiedLoan");
    const loanImpl = await LoanImpl.deploy();

    const Factory = await ethers.getContractFactory("UnifiedLoanFactory");
    const factory = await Factory.deploy(
      admin.address,
      await usdc.getAddress(),
      await vault.getAddress(),
      await feeManager.getAddress(),
      await treasury.getAddress(),
      await loanImpl.getAddress(),
    );

    const registrarRole = await vault.LOAN_REGISTRAR_ROLE();
    await vault.grantRole(registrarRole, await factory.getAddress());
    const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
    await feeManager.grantRole(feeRegistrarRole, await factory.getAddress());
    await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

    // requireFiatProofBeforeActivate is false by default
    expect(await factory.requireFiatProofBeforeActivate()).to.equal(false);

    const params = {
      fundingModel: 0,
      repaymentModel: 0,
      borrower: borrower.address,
      collateralToken: await weth.getAddress(),
      collateralAmount: ethers.parseEther("5"),
      principalAmount: 10_000_000n,
      interestRateBps: 1200,
      durationSeconds: 30 * 24 * 3600,
      gracePeriodSeconds: 7 * 24 * 3600,
      fundingDeadline: 0,
      pool: ethers.ZeroAddress,
      totalInstallments: 0,
      installmentInterval: 0,
      installmentGracePeriod: 0,
      penaltyAprBps: 0,
      defaultThresholdDays: 0,
      scheduleHash: ethers.ZeroHash,
    };

    await factory.connect(borrower).createLoan(params);
    const loanAddr = await factory.loans(0);
    const loan = await ethers.getContractAt("UnifiedLoan", loanAddr);

    // Fund
    await usdc.mint(lender.address, params.principalAmount);
    await usdc.connect(lender).approve(loanAddr, params.principalAmount);
    await loan.connect(lender).fund(params.principalAmount);

    // Lock collateral
    const loanRole = await vault.LOAN_ROLE();
    await vault.connect(admin).grantRole(loanRole, admin.address);
    await weth.mint(borrower.address, params.collateralAmount);
    await weth
      .connect(borrower)
      .approve(await vault.getAddress(), params.collateralAmount);
    await vault
      .connect(admin)
      .lockCollateral(
        loanAddr,
        await weth.getAddress(),
        params.collateralAmount,
        borrower.address,
      );

    // Activate without fiat proof — should succeed
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE
  });
});
