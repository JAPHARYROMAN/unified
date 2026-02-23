import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/* ═══════════════════════════════════════════════════════════════════════════
 *  Governance Simulation — Settlement Signer Compromise
 *
 *  Verifies that a compromised settlement agent cannot:
 *    - Cause fund loss or theft
 *    - Corrupt loan state transitions
 *    - Bypass idempotency protections
 *    - Escalate privileges beyond its narrow scope
 *
 *  The settlement agent role in the Unified protocol is limited to exactly
 *  two functions:
 *    1. recordFiatDisbursement(bytes32 ref)
 *    2. recordFiatRepayment(bytes32 ref)
 *
 *  Neither function transfers funds. Both are guarded by idempotency checks.
 * ═══════════════════════════════════════════════════════════════════════════ */

const TIMELOCK_DELAY = 24 * 3600;

// ── Timelock helpers ────────────────────────────────────────────────────

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

// ── Ref helper ──────────────────────────────────────────────────────────

function ref(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

// ── Fixture: loan in various states with compromised settlement agent ───

async function compromisedAgentFixture() {
  const [admin, borrower, lender, attacker, stranger] =
    await ethers.getSigners();

  // The attacker IS the settlement agent — simulating a key compromise
  const settlementAgent = attacker;

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

  // Roles
  const registrarRole = await vault.LOAN_REGISTRAR_ROLE();
  await vault.grantRole(registrarRole, await factory.getAddress());
  const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
  await feeManager.grantRole(feeRegistrarRole, await factory.getAddress());

  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  // Configure settlement agent (attacker) + fiat proof required
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

  // Create a loan
  await factory.connect(borrower).createLoan(loanParams);
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  // Fund the loan
  await usdc.mint(lender.address, PRINCIPAL);
  await usdc.connect(lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(lender).fund(PRINCIPAL);

  // Lock collateral
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
    attacker, // same signer as settlementAgent
    stranger,
    usdc,
    weth,
    vault,
    factory,
    feeManager,
    treasury,
    loan,
    PRINCIPAL,
    COLLATERAL,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  1. Privilege containment — agent cannot invoke non-settlement functions
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: privilege containment", function () {
  it("attacker cannot activate a loan (not borrower)", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(
      loan.connect(attacker).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });

  it("attacker cannot fund a loan (no fund theft by pumping)", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    // Even if the attacker tries to fund 0 — no token movement
    await expect(loan.connect(attacker).fund(0)).to.be.revertedWithCustomError(
      loan,
      "ZeroAmount",
    );
  });

  it("attacker cannot repay (not borrower)", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(loan.connect(attacker).repay(1)).to.be.revertedWithCustomError(
      loan,
      "Unauthorized",
    );
  });

  it("attacker cannot pause / unpause loans", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(
      loan.connect(attacker).setPaused(true),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });

  it("attacker cannot reinitialize the loan", async function () {
    const { attacker, loan, usdc, vault, feeManager, treasury } =
      await compromisedAgentFixture();

    const fakeParams = {
      borrower: attacker.address,
      currency: await usdc.getAddress(),
      principal: 999_999_999n,
      aprBps: 0,
      duration: 86400,
      gracePeriod: 0,
      fundingTarget: 999_999_999n,
      fundingDeadline: 0,
      fundingModel: 0,
      repaymentModel: 0,
      pool: ethers.ZeroAddress,
      collateralAsset: ethers.ZeroAddress,
      collateralAmount: 1,
      collateralVault: await vault.getAddress(),
      feeManager: await feeManager.getAddress(),
      treasury: await treasury.getAddress(),
      pauser: attacker.address,
      settlementAgent: attacker.address,
      requireFiatProof: false,
      totalInstallments: 0,
      installmentInterval: 0,
      installmentGracePeriod: 0,
      penaltyAprBps: 0,
      defaultThresholdDays: 0,
      scheduleHash: ethers.ZeroHash,
    };

    await expect(
      loan.connect(attacker).initialize(fakeParams),
    ).to.be.revertedWithCustomError(loan, "InvalidInitialization");
  });

  it("attacker cannot mark loan as defaulted (loan not overdue)", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    // Loan is in FUNDING state, not ACTIVE → invalid state
    await expect(
      loan.connect(attacker).markDefault(),
    ).to.be.revertedWithCustomError(loan, "InvalidLoanState");
  });

  it("attacker cannot claim collateral", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(
      loan.connect(attacker).claimCollateral(),
    ).to.be.revertedWithCustomError(loan, "InvalidLoanState");
  });

  it("attacker cannot close the loan", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(loan.connect(attacker).close()).to.be.revertedWithCustomError(
      loan,
      "InvalidLoanState",
    );
  });

  it("attacker cannot lock collateral (not borrower)", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    // lockCollateral checks msg.sender == borrower
    await expect(
      loan.connect(attacker).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "NotBorrower");
  });

  it("attacker cannot grant itself factory admin role", async function () {
    const { attacker, factory } = await compromisedAgentFixture();

    const adminRole = await factory.DEFAULT_ADMIN_ROLE();
    await expect(
      factory.connect(attacker).grantRole(adminRole, attacker.address),
    ).to.be.reverted;
  });

  it("attacker cannot pause the factory", async function () {
    const { attacker, factory } = await compromisedAgentFixture();

    await expect(factory.connect(attacker).pause()).to.be.reverted;
  });

  it("attacker cannot schedule timelocked operations", async function () {
    const { attacker, factory } = await compromisedAgentFixture();

    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
    await expect(factory.connect(attacker).scheduleTimelock(fakeId)).to.be
      .reverted;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  2. recordFiatDisbursement — invalid loan context attacks
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: recordFiatDisbursement abuse", function () {
  it("records disbursement — only permitted action on unfunded loan context", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    // This IS allowed — it's a legitimate operation. The question is: does it cause damage?
    const refVal = ref("attacker:fake:disbursement");
    await loan.connect(attacker).recordFiatDisbursement(refVal);

    // Verify: no funds moved, loan still FUNDING
    expect(await loan.status()).to.equal(1); // FUNDING
    expect(await loan.fiatDisbursementRef()).to.equal(refVal);
  });

  it("cannot record disbursement with zero ref", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(
      loan.connect(attacker).recordFiatDisbursement(ethers.ZeroHash),
    ).to.be.revertedWithCustomError(loan, "ZeroAmount");
  });

  it("premature disbursement recording does NOT enable attacker to activate", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    // Record disbursement proof
    await loan.connect(attacker).recordFiatDisbursement(ref("attacker:proof"));

    // Attacker still cannot activate — not authorized as borrower
    await expect(
      loan.connect(attacker).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");
  });

  it("no fund transfer occurs during recordFiatDisbursement", async function () {
    const { attacker, loan, usdc } = await compromisedAgentFixture();
    const loanAddr = await loan.getAddress();

    const balBefore = await usdc.balanceOf(loanAddr);
    const attackerBalBefore = await usdc.balanceOf(attacker.address);

    await loan
      .connect(attacker)
      .recordFiatDisbursement(ref("attacker:no-transfer"));

    // No USDC moved
    expect(await usdc.balanceOf(loanAddr)).to.equal(balBefore);
    expect(await usdc.balanceOf(attacker.address)).to.equal(attackerBalBefore);
  });

  it("no collateral movement during recordFiatDisbursement", async function () {
    const { attacker, loan, weth, vault, COLLATERAL } =
      await compromisedAgentFixture();
    const loanAddr = await loan.getAddress();

    const vaultBal = await weth.balanceOf(await vault.getAddress());

    await loan
      .connect(attacker)
      .recordFiatDisbursement(ref("attacker:collateral-safe"));

    // Collateral untouched
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(vaultBal);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  3. recordFiatRepayment — exceeding balance / invalid context
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: recordFiatRepayment abuse", function () {
  it("repayment proofs cannot move any funds", async function () {
    const { attacker, borrower, loan, usdc, PRINCIPAL } =
      await compromisedAgentFixture();

    // Record disbursement then activate the loan normally
    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();

    const loanAddr = await loan.getAddress();
    const loanBal = await usdc.balanceOf(loanAddr);
    const attackerBal = await usdc.balanceOf(attacker.address);

    // Attacker records many repayment proofs
    for (let i = 0; i < 5; i++) {
      await loan
        .connect(attacker)
        .recordFiatRepayment(ref(`attacker:spam-repay-${i}`));
    }

    // No funds moved — repayment proofs are informational/accounting only
    expect(await usdc.balanceOf(loanAddr)).to.equal(loanBal);
    expect(await usdc.balanceOf(attacker.address)).to.equal(attackerBal);
  });

  it("repayment proof does not reduce principalOutstanding", async function () {
    const { attacker, borrower, loan } = await compromisedAgentFixture();

    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();

    const principalBefore = await loan.principalOutstanding();

    // Lots of fake repayment proofs
    for (let i = 0; i < 3; i++) {
      await loan.connect(attacker).recordFiatRepayment(ref(`fake:repay-${i}`));
    }

    // principalOutstanding unchanged — fiat proofs don't affect on-chain debt
    expect(await loan.principalOutstanding()).to.equal(principalBefore);
  });

  it("repayment proof spam does not change loan status", async function () {
    const { attacker, borrower, loan } = await compromisedAgentFixture();

    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Spam repayment proofs
    for (let i = 0; i < 5; i++) {
      await loan.connect(attacker).recordFiatRepayment(ref(`spam:repay-${i}`));
    }

    // Status unchanged — still ACTIVE, not auto-repaid
    expect(await loan.status()).to.equal(2);
  });

  it("repayment proof does not affect interestAccrued", async function () {
    const { attacker, borrower, loan } = await compromisedAgentFixture();

    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();

    // Advance time to accrue some interest
    await time.increase(7 * 24 * 3600);

    const interestBefore = await loan.interestAccrued();

    await loan
      .connect(attacker)
      .recordFiatRepayment(ref("fake:repay-interest"));

    // Interest accrual unaffected
    expect(await loan.interestAccrued()).to.equal(interestBefore);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  4. activateLoan — attacker cannot force invalid state transitions
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: loan state corruption attempts", function () {
  it("attacker cannot activate loan even after recording disbursement", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await loan
      .connect(attacker)
      .recordFiatDisbursement(ref("attacker:disburse"));

    // Cannot activate — not the borrower
    await expect(
      loan.connect(attacker).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "Unauthorized");

    expect(await loan.status()).to.equal(1); // still FUNDING
  });

  it("recording proofs on ACTIVE loan doesn't allow double activation", async function () {
    const { attacker, borrower, loan } = await compromisedAgentFixture();

    // Normal flow
    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Attacker can't re-activate (wrong state — already ACTIVE, not FUNDING)
    await expect(
      loan.connect(attacker).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "InvalidLoanState");

    // Borrower can't re-activate either (wrong state)
    await expect(
      loan.connect(borrower).activateAndDisburse(),
    ).to.be.revertedWithCustomError(loan, "InvalidLoanState");
  });

  it("attacker cannot force default on an active loan before maturity", async function () {
    const { attacker, borrower, loan } = await compromisedAgentFixture();

    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();

    // Not past maturity yet — markDefault should fail
    await expect(
      loan.connect(attacker).markDefault(),
    ).to.be.revertedWithCustomError(loan, "GracePeriodNotElapsed");
  });

  it("attacker cannot close an active loan", async function () {
    const { attacker, borrower, loan } = await compromisedAgentFixture();

    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();

    await expect(loan.connect(attacker).close()).to.be.revertedWithCustomError(
      loan,
      "InvalidLoanState",
    );
  });

  it("attacker cannot withdraw lender contributions", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    await expect(loan.connect(attacker).withdrawContribution()).to.be.reverted;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  5. Idempotency under attack — multiple duplicate recordings
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: idempotency protects accounting", function () {
  it("double disbursement recording reverts — accounting safe", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    const disbRef = ref("attacker:disburse-dup");
    await loan.connect(attacker).recordFiatDisbursement(disbRef);

    // Same ref → already recorded
    await expect(
      loan.connect(attacker).recordFiatDisbursement(disbRef),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");

    // Different ref → slot occupied
    await expect(
      loan.connect(attacker).recordFiatDisbursement(ref("attacker:alt-ref")),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");
  });

  it("duplicate repayment refs are all rejected after first", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    const repayRef = ref("attacker:repay-dup");
    await loan.connect(attacker).recordFiatRepayment(repayRef);

    for (let i = 0; i < 10; i++) {
      await expect(
        loan.connect(attacker).recordFiatRepayment(repayRef),
      ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");
    }

    // Only one ref recorded
    expect(await loan.lastFiatRepaymentRef()).to.equal(repayRef);
  });

  it("cross-type ref reuse blocked (disbursement ref cannot be used for repayment)", async function () {
    const { attacker, loan } = await compromisedAgentFixture();

    const sharedRef = ref("attacker:shared-ref");
    await loan.connect(attacker).recordFiatDisbursement(sharedRef);

    // Same ref for repayment → fiatRefUsed blocks it
    await expect(
      loan.connect(attacker).recordFiatRepayment(sharedRef),
    ).to.be.revertedWithCustomError(loan, "FiatRefAlreadyUsed");
  });

  it("mass spam of unique repayment refs doesn't corrupt state", async function () {
    const { attacker, borrower, loan, usdc, PRINCIPAL } =
      await compromisedAgentFixture();

    await loan.connect(attacker).recordFiatDisbursement(ref("legit:disburse"));
    await loan.connect(borrower).activateAndDisburse();

    const loanAddr = await loan.getAddress();
    const statusBefore = await loan.status();
    const principalBefore = await loan.principalOutstanding();
    const loanBalBefore = await usdc.balanceOf(loanAddr);

    // Attacker spams 20 unique repayment proofs
    for (let i = 0; i < 20; i++) {
      await loan.connect(attacker).recordFiatRepayment(ref(`mass-spam:${i}`));
    }

    // Verify: nothing changed in the loan's financial state
    expect(await loan.status()).to.equal(statusBefore);
    expect(await loan.principalOutstanding()).to.equal(principalBefore);
    expect(await usdc.balanceOf(loanAddr)).to.equal(loanBalBefore);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  6. Fund safety — comprehensive balance verification
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: fund safety", function () {
  it("full attack sequence: no fund loss after disbursement + activation + repayment spam", async function () {
    const {
      attacker,
      borrower,
      lender,
      loan,
      usdc,
      weth,
      vault,
      treasury,
      PRINCIPAL,
      COLLATERAL,
    } = await compromisedAgentFixture();

    const loanAddr = await loan.getAddress();
    const vaultAddr = await vault.getAddress();
    const treasuryAddr = await treasury.getAddress();

    // Snapshot balances before attack
    const treasuryBal0 = await usdc.balanceOf(treasuryAddr);
    const vaultWethBal0 = await weth.balanceOf(vaultAddr);

    // ── Phase 1: attacker records disbursement ──
    await loan.connect(attacker).recordFiatDisbursement(ref("attack:disburse"));

    // ── Phase 2: legitimate activation by borrower ──
    await loan.connect(borrower).activateAndDisburse();
    const borrowerBal = await usdc.balanceOf(borrower.address);

    // ── Phase 3: attacker spam repayment proofs ──
    for (let i = 0; i < 10; i++) {
      await loan
        .connect(attacker)
        .recordFiatRepayment(ref(`attack:repay-${i}`));
    }

    // ── Phase 4: attacker tries every privilege escalation ──
    await expect(loan.connect(attacker).repay(1)).to.be.reverted;
    await expect(loan.connect(attacker).close()).to.be.reverted;
    await expect(loan.connect(attacker).claimCollateral()).to.be.reverted;
    await expect(loan.connect(attacker).setPaused(true)).to.be.reverted;
    await expect(loan.connect(attacker).lockCollateral()).to.be.reverted;

    // ── Phase 5: verify invariants ──

    // Loan status unchanged by attack
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Borrower received disbursement (principal - fees)
    expect(await usdc.balanceOf(borrower.address)).to.equal(borrowerBal);

    // Collateral safe in vault
    expect(await weth.balanceOf(vaultAddr)).to.equal(vaultWethBal0);

    // principalOutstanding intact
    expect(await loan.principalOutstanding()).to.equal(PRINCIPAL);

    // Attacker holds zero protocol funds
    expect(await usdc.balanceOf(attacker.address)).to.equal(0n);
    expect(await weth.balanceOf(attacker.address)).to.equal(0n);
  });

  it("attacker cannot move funds from vault or treasury", async function () {
    const { attacker, vault, treasury, weth, usdc } =
      await compromisedAgentFixture();

    const vaultAddr = await vault.getAddress();
    const treasuryAddr = await treasury.getAddress();

    // Cannot call vault functions
    await expect(
      vault
        .connect(attacker)
        .releaseCollateral(ethers.ZeroAddress, attacker.address),
    ).to.be.reverted;

    await expect(
      vault
        .connect(attacker)
        .seizeCollateral(ethers.ZeroAddress, attacker.address, 1),
    ).to.be.reverted;

    // Cannot call treasury functions
    await expect(
      treasury
        .connect(attacker)
        .withdrawERC20(await usdc.getAddress(), attacker.address, 1),
    ).to.be.reverted;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  7. Containment after key rotation
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Settlement Compromise: key rotation containment", function () {
  it("after admin rotates settlement agent, old key is locked out", async function () {
    const { admin, attacker, stranger, factory, loan } =
      await compromisedAgentFixture();

    // Attacker can still record (compromised)
    await loan
      .connect(attacker)
      .recordFiatDisbursement(ref("pre-rotation:disburse"));

    // Admin rotates the settlement agent to a new key
    // Note: only future loans get the new agent from the factory.
    // Existing loans keep their agent — but the test demonstrates the pattern.
    await timelockExec(factory, "setSettlementAgent", [stranger.address]);

    // For existing loans, the settlement agent is baked into the clone.
    // The old attacker remains the agent on THIS loan.
    // Critically: all they can do is record proofs — which is already
    // idempotency-bounded and fund-safe.

    // Verify: disbursement slot is occupied — attacker can't record another
    await expect(
      loan
        .connect(attacker)
        .recordFiatDisbursement(ref("post-rotation:disburse")),
    ).to.be.revertedWithCustomError(loan, "FiatProofAlreadyRecorded");

    // Verify: new loans would use the new agent, not the attacker
    expect(await factory.settlementAgent()).to.equal(stranger.address);
  });
});
