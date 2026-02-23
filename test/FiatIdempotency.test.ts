import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/* ═══════════════════════════════════════════════════════════════════════════
 *  Fiat Idempotency Validation — Unified v1.1
 *
 *  Tests that:
 *    1. recordFiatDisbursement  — cannot double-record; emits FiatActionRecorded
 *    2. recordFiatRepayment     — cannot double-count; emits FiatActionRecorded
 *    3. activateLoan            — requires disbursement recorded; cannot activate twice
 *    4. Duplicate submission edge cases are safe
 * ═══════════════════════════════════════════════════════════════════════════ */

const TIMELOCK_DELAY = 24 * 3600;

// ── Timelock helpers (same pattern as other test files) ─────────────────

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

// ── Shared refs ─────────────────────────────────────────────────────────

function ref(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

const REF_DISBURSE_1 = ref("settlement:wire:DISBURSE-001");
const REF_DISBURSE_2 = ref("settlement:wire:DISBURSE-002");
const REF_REPAY_1 = ref("settlement:wire:REPAY-001");
const REF_REPAY_2 = ref("settlement:wire:REPAY-002");

// ── Fixture: fully-funded loan with fiat proof required ─────────────────

async function fiatIdempotencyFixture() {
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

  // Grant roles to factory
  const registrarRole = await vault.LOAN_REGISTRAR_ROLE();
  await vault.grantRole(registrarRole, await factory.getAddress());
  const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
  await feeManager.grantRole(feeRegistrarRole, await factory.getAddress());

  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  // Enable fiat proof requirement + set settlement agent
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

  // Mint and lock collateral
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
    vault,
    factory,
    loan,
    PRINCIPAL,
    COLLATERAL,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  1. recordFiatDisbursement — idempotency & event validation
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Fiat Idempotency: recordFiatDisbursement", function () {
  it("records disbursement and emits FiatDisbursementRecorded + FiatActionRecorded (type 0)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();
    const loanAddr = await loan.getAddress();

    const tx = loan
      .connect(settlementAgent)
      .recordFiatDisbursement(REF_DISBURSE_1);

    // Both events must fire
    await expect(tx)
      .to.emit(loan, "FiatDisbursementRecorded")
      .withArgs(loanAddr, REF_DISBURSE_1, () => true);

    await expect(tx)
      .to.emit(loan, "FiatActionRecorded")
      .withArgs(loanAddr, REF_DISBURSE_1, 0, () => true);

    // State updated
    expect(await loan.fiatDisbursementRef()).to.equal(REF_DISBURSE_1);
    expect(await loan.fiatDisbursedAt()).to.be.greaterThan(0);
    expect(await loan.fiatRefUsed(REF_DISBURSE_1)).to.equal(true);
  });

  it("reverts on duplicate disbursement (same ref)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);

    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");
  });

  it("reverts on duplicate disbursement (different ref — slot already occupied)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);

    // Second call with a DIFFERENT ref still reverts — only one disbursement allowed
    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_2),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");
  });

  it("reverts when ref is bytes32(0)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(ethers.ZeroHash),
    ).to.be.revertedWithCustomError(loan, "ZeroAmount");
  });

  it("reverts when caller is not settlement agent", async function () {
    const { stranger, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(stranger).recordFiatDisbursement(REF_DISBURSE_1),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  2. recordFiatRepayment — idempotency & event validation
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Fiat Idempotency: recordFiatRepayment", function () {
  it("records repayment and emits FiatRepaymentRecorded + FiatActionRecorded (type 1)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();
    const loanAddr = await loan.getAddress();

    const tx = loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1);

    await expect(tx)
      .to.emit(loan, "FiatRepaymentRecorded")
      .withArgs(loanAddr, REF_REPAY_1, () => true);

    await expect(tx)
      .to.emit(loan, "FiatActionRecorded")
      .withArgs(loanAddr, REF_REPAY_1, 1, () => true);

    expect(await loan.lastFiatRepaymentRef()).to.equal(REF_REPAY_1);
    expect(await loan.fiatRefUsed(REF_REPAY_1)).to.equal(true);
  });

  it("allows multiple repayments with distinct refs", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1);
    expect(await loan.lastFiatRepaymentRef()).to.equal(REF_REPAY_1);

    await loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_2);
    expect(await loan.lastFiatRepaymentRef()).to.equal(REF_REPAY_2);

    // Both refs are marked as used
    expect(await loan.fiatRefUsed(REF_REPAY_1)).to.equal(true);
    expect(await loan.fiatRefUsed(REF_REPAY_2)).to.equal(true);
  });

  it("reverts on duplicate repayment ref (FiatRefAlreadyUsed)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1);

    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1),
    ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");
  });

  it("reverts when ref is bytes32(0)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(ethers.ZeroHash),
    ).to.be.revertedWithCustomError(loan, "ZeroAmount");
  });

  it("reverts when caller is not settlement agent", async function () {
    const { stranger, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(stranger).recordFiatRepayment(REF_REPAY_1),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });

  it("disbursement ref cannot be reused as repayment ref", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    // Record disbursement first (marks ref as used in fiatRefUsed mapping)
    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);

    // Attempt to reuse the same ref for repayment
    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(REF_DISBURSE_1),
    ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  3. activateLoan — requires disbursement proof, cannot activate twice
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Fiat Idempotency: activateLoan (activateAndDisburse)", function () {
  it("reverts activation when fiat proof is required but not recorded", async function () {
    const { borrower, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(borrower).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "FiatProofMissing");
  });

  it("activates successfully after disbursement proof is recorded", async function () {
    const { borrower, settlementAgent, loan } = await fiatIdempotencyFixture();

    // Record fiat proof
    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);

    // Activation succeeds
    await expect(loan.connect(borrower).activateAndDisburse())
      .to.emit(loan, "Activated")
      .withArgs(borrower.address, () => true);

    expect(await loan.status()).to.equal(2); // ACTIVE
  });

  it("cannot activate twice (InvalidLoanState)", async function () {
    const { borrower, settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Second activation attempt — loan is no longer in FUNDING state
    await expect(
      loan.connect(borrower).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "InvalidLoanState");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  4. Duplicate submission edge cases — safe resubmission
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Fiat Idempotency: duplicate submission edge cases", function () {
  it("rapid-fire duplicate disbursement calls are all safely rejected after first", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    // First succeeds
    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);

    // Rapid duplicate submissions — all rejected, state unchanged
    const duplicateAttempts = Array.from({ length: 5 }, () =>
      loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_2),
    );

    for (const attempt of duplicateAttempts) {
      await expect(attempt).to.be.revertedWithCustomError(
        loan,
        "FiatProofAlreadyRecorded",
      );
    }

    // State remains from first successful call
    expect(await loan.fiatDisbursementRef()).to.equal(REF_DISBURSE_1);
  });

  it("rapid-fire duplicate repayment calls with same ref are safely rejected", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1);

    const duplicateAttempts = Array.from({ length: 5 }, () =>
      loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1),
    );

    for (const attempt of duplicateAttempts) {
      await expect(attempt).to.be.revertedWithCustomError(
        loan,
        "FiatRefAlreadyUsed",
      );
    }

    expect(await loan.lastFiatRepaymentRef()).to.equal(REF_REPAY_1);
  });

  it("disbursement after activation is still rejected (idempotent)", async function () {
    const { borrower, settlementAgent, loan } = await fiatIdempotencyFixture();

    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);
    await loan.connect(borrower).activateAndDisburse();

    // Attempting another disbursement recording — still reverts
    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_2),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");
  });

  it("repayment ref reuse across separate repayments is rejected", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    // First repayment with ref1
    await loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1);
    // Second with ref2 — ok
    await loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_2);
    // Try ref1 again — must fail
    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1),
    ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");
  });

  it("zero ref is always rejected (disbursement and repayment)", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(ethers.ZeroHash),
    ).to.be.revertedWithCustomError(loan, "ZeroAmount");

    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(ethers.ZeroHash),
    ).to.be.revertedWithCustomError(loan, "ZeroAmount");
  });

  it("FiatActionRecorded event consistently emits correct actionType", async function () {
    const { settlementAgent, loan } = await fiatIdempotencyFixture();
    const loanAddr = await loan.getAddress();

    // Disbursement → actionType 0
    const txDisburse = loan
      .connect(settlementAgent)
      .recordFiatDisbursement(REF_DISBURSE_1);
    await expect(txDisburse)
      .to.emit(loan, "FiatActionRecorded")
      .withArgs(loanAddr, REF_DISBURSE_1, 0, () => true);

    // Repayment → actionType 1
    const txRepay = loan
      .connect(settlementAgent)
      .recordFiatRepayment(REF_REPAY_1);
    await expect(txRepay)
      .to.emit(loan, "FiatActionRecorded")
      .withArgs(loanAddr, REF_REPAY_1, 1, () => true);
  });

  it("full idempotent lifecycle: disburse → activate → repay — no double-count", async function () {
    const { borrower, settlementAgent, usdc, loan, PRINCIPAL } =
      await fiatIdempotencyFixture();
    const loanAddr = await loan.getAddress();

    // 1. Record fiat disbursement
    await loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_1);

    // 2. Activate
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // 3. Record fiat repayment
    await expect(loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1))
      .to.emit(loan, "FiatActionRecorded")
      .withArgs(loanAddr, REF_REPAY_1, 1, () => true);

    // 4. Duplicate fiat disbursement — safe
    await expect(
      loan.connect(settlementAgent).recordFiatDisbursement(REF_DISBURSE_2),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");

    // 5. Duplicate fiat repayment — safe
    await expect(
      loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_1),
    ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");

    // 6. Second distinct repayment — allowed
    await expect(loan.connect(settlementAgent).recordFiatRepayment(REF_REPAY_2))
      .to.emit(loan, "FiatActionRecorded")
      .withArgs(loanAddr, REF_REPAY_2, 1, () => true);

    // 7. State integrity
    expect(await loan.fiatDisbursementRef()).to.equal(REF_DISBURSE_1);
    expect(await loan.lastFiatRepaymentRef()).to.equal(REF_REPAY_2);
    expect(await loan.fiatRefUsed(REF_DISBURSE_1)).to.equal(true);
    expect(await loan.fiatRefUsed(REF_REPAY_1)).to.equal(true);
    expect(await loan.fiatRefUsed(REF_REPAY_2)).to.equal(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  Governance Simulation — Active Without Disbursement Proof
 *  Contract-level impossible-state validation
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Governance Simulation: Active Without Disbursement Proof", function () {
  it("reverts activateLoan before disbursement proof is recorded", async function () {
    const { borrower, loan } = await fiatIdempotencyFixture();

    await expect(
      loan.connect(borrower).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "FiatProofMissing");
  });
});
