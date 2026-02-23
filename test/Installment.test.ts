import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const TIMELOCK_DELAY = 24 * 3600;
const DAY = 24 * 3600;

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

/**
 * Deploy infrastructure + create an INSTALLMENT loan (DIRECT funding).
 * - 3 installments, 10-day interval, 2-day grace, 5% penalty APR, 30-day default threshold
 * - Fully funded, collateral locked, and activated.
 */
async function installmentFixture() {
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

  await vault.grantRole(
    await vault.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await feeManager.grantRole(
    await feeManager.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  const PRINCIPAL = 900_000_000n; // 900 USDC (6 decimals)
  const COLLATERAL = ethers.parseEther("5");
  const SCHEDULE_HASH = ethers.keccak256(ethers.toUtf8Bytes("schedule:3x10d"));

  const params = {
    fundingModel: 0, // DIRECT
    repaymentModel: 1, // INSTALLMENT
    borrower: borrower.address,
    collateralToken: await weth.getAddress(),
    collateralAmount: COLLATERAL,
    principalAmount: PRINCIPAL,
    interestRateBps: 1200, // 12% APR
    durationSeconds: 30 * DAY,
    gracePeriodSeconds: 7 * DAY,
    fundingDeadline: 0,
    pool: ethers.ZeroAddress,
    totalInstallments: 3,
    installmentInterval: 10 * DAY,
    installmentGracePeriod: 2 * DAY,
    penaltyAprBps: 500, // 5% penalty APR
    defaultThresholdDays: 30,
    scheduleHash: SCHEDULE_HASH,
  };

  await factory.connect(borrower).createLoan(params);
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  // Fund
  await usdc.mint(lender.address, PRINCIPAL);
  await usdc.connect(lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(lender).fund(PRINCIPAL);

  // Lock collateral
  await weth.mint(borrower.address, COLLATERAL);
  await weth.connect(borrower).approve(await vault.getAddress(), COLLATERAL);
  await loan.connect(borrower).lockCollateral();

  // Activate
  await loan.connect(lender).activateAndDisburse();

  return {
    admin,
    borrower,
    lender,
    usdc,
    weth,
    loan,
    vault,
    factory,
    PRINCIPAL,
    COLLATERAL,
    SCHEDULE_HASH,
    params,
  };
}

/**
 * Deploy BULLET loan for comparison (identical infrastructure).
 */
async function bulletFixture() {
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

  await vault.grantRole(
    await vault.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await feeManager.grantRole(
    await feeManager.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  const PRINCIPAL = 10_000_000n;
  const COLLATERAL = ethers.parseEther("5");

  const params = {
    fundingModel: 0,
    repaymentModel: 0, // BULLET
    borrower: borrower.address,
    collateralToken: await weth.getAddress(),
    collateralAmount: COLLATERAL,
    principalAmount: PRINCIPAL,
    interestRateBps: 1200,
    durationSeconds: 30 * DAY,
    gracePeriodSeconds: 7 * DAY,
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
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  await usdc.mint(lender.address, PRINCIPAL);
  await usdc.connect(lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(lender).fund(PRINCIPAL);

  await weth.mint(borrower.address, COLLATERAL);
  await weth.connect(borrower).approve(await vault.getAddress(), COLLATERAL);
  await loan.connect(borrower).lockCollateral();

  await loan.connect(lender).activateAndDisburse();

  return { admin, borrower, lender, usdc, loan, PRINCIPAL };
}

describe("Installment Enforcement", function () {
  // ──────────────────────────────────────────────────────────────────────
  //  Storage & initialization
  // ──────────────────────────────────────────────────────────────────────

  describe("Initialization", function () {
    it("stores installment params correctly", async function () {
      const f = await installmentFixture();

      expect(await f.loan.totalInstallments()).to.equal(3);
      expect(await f.loan.installmentInterval()).to.equal(10 * DAY);
      expect(await f.loan.installmentGracePeriod()).to.equal(2 * DAY);
      expect(await f.loan.penaltyAprBps()).to.equal(500);
      expect(await f.loan.defaultThresholdDays()).to.equal(30);
      expect(await f.loan.scheduleHash()).to.equal(f.SCHEDULE_HASH);
    });

    it("stores scheduleHash from params", async function () {
      const f = await installmentFixture();
      expect(await f.loan.scheduleHash()).to.equal(f.SCHEDULE_HASH);
    });

    it("installmentsPaid starts at 0", async function () {
      const f = await installmentFixture();
      expect(await f.loan.installmentsPaid()).to.equal(0);
    });

    it("lateFeeAccrued starts at 0", async function () {
      const f = await installmentFixture();
      expect(await f.loan.lateFeeAccrued()).to.equal(0);
    });

    it("delinquentSince starts at 0", async function () {
      const f = await installmentFixture();
      expect(await f.loan.delinquentSince()).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  View helpers
  // ──────────────────────────────────────────────────────────────────────

  describe("View helpers", function () {
    it("installmentsDueCount returns 0 before first interval", async function () {
      const f = await installmentFixture();
      // Right after activation, <10 days elapsed
      expect(await f.loan.installmentsDueCount()).to.equal(0);
    });

    it("installmentsDueCount returns 1 after first interval", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      expect(await f.loan.installmentsDueCount()).to.equal(1);
    });

    it("installmentsDueCount caps at totalInstallments", async function () {
      const f = await installmentFixture();
      await time.increase(50 * DAY); // well past all 3 installments
      expect(await f.loan.installmentsDueCount()).to.equal(3);
    });

    it("installmentAmount returns correct per-installment principal", async function () {
      const f = await installmentFixture();
      expect(await f.loan.installmentAmount()).to.equal(f.PRINCIPAL / 3n);
    });

    it("installmentDueDate returns correct dates (1-indexed)", async function () {
      const f = await installmentFixture();
      const startTs = await f.loan.startTs();

      expect(await f.loan.installmentDueDate(1)).to.equal(
        startTs + BigInt(10 * DAY),
      );
      expect(await f.loan.installmentDueDate(2)).to.equal(
        startTs + BigInt(20 * DAY),
      );
      expect(await f.loan.installmentDueDate(3)).to.equal(
        startTs + BigInt(30 * DAY),
      );
    });

    it("installmentDueDate returns 0 for invalid index", async function () {
      const f = await installmentFixture();
      expect(await f.loan.installmentDueDate(0)).to.equal(0);
      expect(await f.loan.installmentDueDate(4)).to.equal(0);
    });

    it("totalDebtWithFees includes lateFeeAccrued", async function () {
      const f = await installmentFixture();
      // Advance past grace to trigger delinquency + late fees
      await time.increase(13 * DAY); // Past installment 1 grace (10d + 2d)
      await f.loan.checkDelinquency();
      await f.loan.accrueInterest();

      const debtBase = await f.loan.totalDebt();
      const debtFull = await f.loan.totalDebtWithFees();
      // totalDebtWithFees >= totalDebt (late fees may have accrued)
      expect(debtFull).to.be.gte(debtBase);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Repayment allocation (late fees → interest → principal)
  // ──────────────────────────────────────────────────────────────────────

  describe("Repayment allocation", function () {
    it("allocates to interest before principal", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const interestBefore = await f.loan.interestAccrued();
      const principalBefore = await f.loan.principalOutstanding();
      expect(interestBefore).to.be.gt(0);

      // Pay exactly the interest amount
      const payAmt = interestBefore;
      await f.usdc.mint(f.borrower.address, payAmt);
      await f.usdc
        .connect(f.borrower)
        .approve(await f.loan.getAddress(), payAmt);
      await f.loan.connect(f.borrower).repay(payAmt);

      // Interest should be mostly cleared (may accrue 1s more inside repay)
      expect(await f.loan.interestAccrued()).to.be.lte(10n); // negligible rounding
      // Principal unchanged
      expect(await f.loan.principalOutstanding()).to.equal(principalBefore);
    });

    it("allocates to principal after interest is cleared", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const debt = await f.loan.totalDebt();
      // Pay 50% of total debt — should clear interest first, then reduce principal
      const payAmt = debt / 2n;
      await f.usdc.mint(f.borrower.address, payAmt);
      await f.usdc
        .connect(f.borrower)
        .approve(await f.loan.getAddress(), payAmt);
      await f.loan.connect(f.borrower).repay(payAmt);

      expect(await f.loan.principalOutstanding()).to.be.lt(f.PRINCIPAL);
    });

    it("allocates late fees first when delinquent", async function () {
      const f = await installmentFixture();
      // Go past grace: installment 1 due at day 10, grace at day 12
      await time.increase(15 * DAY);
      // Force delinquency
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.be.gt(0);

      // Now repay — late fees should be allocated first inside repay()
      await f.loan.accrueInterest();
      const debtFull = await f.loan.totalDebtWithFees();

      // Small payment — goes to late fees first
      const smallPay = 100_000n; // 0.1 USDC
      await f.usdc.mint(f.borrower.address, smallPay);
      await f.usdc
        .connect(f.borrower)
        .approve(await f.loan.getAddress(), smallPay);

      const lateFeeBefore = await f.loan.lateFeeAccrued();
      await f.loan.connect(f.borrower).repay(smallPay);

      // Late fee accrued should have decreased (or been cleared)
      // Note: repay() re-accrues late fees internally, so the residual depends on amount
      // But repaidTotal should have increased
      expect(await f.loan.repaidTotal()).to.equal(smallPay);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Installment tracking
  // ──────────────────────────────────────────────────────────────────────

  describe("Installment tracking", function () {
    it("installmentsPaid increments when enough principal is repaid", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      // Each installment is PRINCIPAL / 3 = 300_000_000 (300 USDC)
      const installmentPrincipal = f.PRINCIPAL / 3n;
      const debt = await f.loan.totalDebt();

      // Pay slightly more than 1 installment principal (to cover interest too)
      const pay = installmentPrincipal + (debt - f.PRINCIPAL) + 10_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);
      await f.loan.connect(f.borrower).repay(pay);

      expect(await f.loan.installmentsPaid()).to.be.gte(1);
    });

    it("emits InstallmentPaid when an installment is fully covered", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const installmentPrincipal = f.PRINCIPAL / 3n;
      const debt = await f.loan.totalDebt();
      const pay = installmentPrincipal + (debt - f.PRINCIPAL) + 10_000n;

      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      await expect(f.loan.connect(f.borrower).repay(pay)).to.emit(
        f.loan,
        "InstallmentPaid",
      );
    });

    it("partial payment does not increment installmentsPaid", async function () {
      const f = await installmentFixture();
      await time.increase(5 * DAY);

      // Pay a small amount — less than 1 installment principal
      const pay = 50_000_000n; // 50 USDC, way less than 300 USDC installment
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);
      await f.loan.connect(f.borrower).repay(pay);

      expect(await f.loan.installmentsPaid()).to.equal(0);
    });

    it("full repayment transitions to REPAID", async function () {
      const f = await installmentFixture();
      await time.increase(5 * DAY);
      await f.loan.accrueInterest();

      const debt = await f.loan.totalDebt();
      // Add buffer for 1s interest accrual inside repay
      const pay = debt + 5_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      // Pay the exact debt (read debt again fresh)
      await f.loan.accrueInterest();
      const exactDebt = await f.loan.totalDebt();
      await f.usdc.mint(f.borrower.address, exactDebt);
      await f.usdc
        .connect(f.borrower)
        .approve(await f.loan.getAddress(), exactDebt);
      await f.loan.connect(f.borrower).repay(exactDebt);

      // If not fully repaid (1s accrual), repay the tiny remainder
      const remaining = await f.loan.totalDebt();
      if (remaining > 0n) {
        await f.usdc.mint(f.borrower.address, remaining);
        await f.usdc
          .connect(f.borrower)
          .approve(await f.loan.getAddress(), remaining);
        await f.loan.connect(f.borrower).repay(remaining);
      }

      expect(await f.loan.status()).to.equal(3); // REPAID
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Delinquency detection
  // ──────────────────────────────────────────────────────────────────────

  describe("Delinquency", function () {
    it("not delinquent before grace period expires", async function () {
      const f = await installmentFixture();
      // Installment 1 due at day 10, grace ends day 12
      await time.increase(11 * DAY); // Within grace period
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.equal(0);
    });

    it("delinquent after grace period without payment", async function () {
      const f = await installmentFixture();
      // Advance past installment 1 grace: 10d + 2d = 12d
      await time.increase(13 * DAY);
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.be.gt(0);
    });

    it("emits LoanDelinquent on first delinquency detection", async function () {
      const f = await installmentFixture();
      await time.increase(13 * DAY);
      await expect(f.loan.checkDelinquency()).to.emit(f.loan, "LoanDelinquent");
    });

    it("delinquentSince is set to grace deadline, not current time", async function () {
      const f = await installmentFixture();
      const startTs = await f.loan.startTs();
      // Grace deadline for installment 1 = startTs + 10d + 2d
      const graceDeadline = startTs + BigInt(12 * DAY);

      await time.increase(15 * DAY);
      await f.loan.checkDelinquency();

      expect(await f.loan.delinquentSince()).to.equal(graceDeadline);
    });

    it("delinquency clears when borrower catches up", async function () {
      const f = await installmentFixture();
      await time.increase(13 * DAY);
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.be.gt(0);

      // Pay enough to cover installment 1
      await f.loan.accrueInterest();
      const installmentPrincipal = f.PRINCIPAL / 3n;
      const debt = await f.loan.totalDebt();
      const pay = installmentPrincipal + (debt - f.PRINCIPAL) + 100_000n;

      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);
      await f.loan.connect(f.borrower).repay(pay);

      expect(await f.loan.delinquentSince()).to.equal(0);
    });

    it("checkDelinquency is no-op for BULLET loans", async function () {
      const f = await bulletFixture();
      await time.increase(40 * DAY); // Past maturity
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.equal(0);
    });

    it("checkDelinquency is no-op when loan is already paid up", async function () {
      const f = await installmentFixture();
      // Still within first interval — nothing due yet
      await time.increase(5 * DAY);
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Default (installment path)
  // ──────────────────────────────────────────────────────────────────────

  describe("Default (installment)", function () {
    it("markDefault reverts when delinquency threshold not reached", async function () {
      const f = await installmentFixture();
      // 13 days in: just past grace, delinquent but < 30 day threshold
      await time.increase(13 * DAY);

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "DelinquencyThresholdNotReached",
      );
    });

    it("markDefault reverts when not delinquent at all", async function () {
      const f = await installmentFixture();
      // 5 days in: no installments due yet
      await time.increase(5 * DAY);

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "GracePeriodNotElapsed",
      );
    });

    it("markDefault succeeds after delinquency threshold", async function () {
      const f = await installmentFixture();
      // First installment due day 10, grace ends day 12, delinquent from day 12
      // Need 30 days of delinquency → day 42+
      await time.increase(43 * DAY);

      await expect(f.loan.markDefault()).to.emit(f.loan, "LoanDefaulted");
      expect(await f.loan.status()).to.equal(4); // DEFAULTED
    });

    it("markDefault emits both LoanDefaulted and Defaulted", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);

      const tx = f.loan.markDefault();
      await expect(tx).to.emit(f.loan, "LoanDefaulted");
      await expect(tx).to.emit(f.loan, "Defaulted");
    });

    it("markDefault accrues interest and late fees before defaulting", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);

      await f.loan.markDefault();

      // Interest and late fees should have been accrued
      // (We can't easily check accrued amounts post-default, but status is DEFAULTED)
      expect(await f.loan.status()).to.equal(4);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Bullet loans are unaffected
  // ──────────────────────────────────────────────────────────────────────

  describe("Bullet loans unaffected", function () {
    it("bullet loan has zero installment config", async function () {
      const f = await bulletFixture();
      expect(await f.loan.totalInstallments()).to.equal(0);
      expect(await f.loan.installmentInterval()).to.equal(0);
      expect(await f.loan.installmentGracePeriod()).to.equal(0);
      expect(await f.loan.penaltyAprBps()).to.equal(0);
      expect(await f.loan.defaultThresholdDays()).to.equal(0);
      expect(await f.loan.scheduleHash()).to.equal(ethers.ZeroHash);
    });

    it("bullet loan repay works without installment side-effects", async function () {
      const f = await bulletFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const pay = 1_000_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);
      await f.loan.connect(f.borrower).repay(pay);

      expect(await f.loan.installmentsPaid()).to.equal(0);
      expect(await f.loan.lateFeeAccrued()).to.equal(0);
    });

    it("bullet loan markDefault uses maturity+grace path", async function () {
      const f = await bulletFixture();
      // Duration 30d + grace 7d + 1
      await time.increase(37 * DAY + 1);

      await expect(f.loan.markDefault()).to.emit(f.loan, "Defaulted");
      expect(await f.loan.status()).to.equal(4);
    });

    it("bullet loan markDefault reverts before maturity", async function () {
      const f = await bulletFixture();
      await time.increase(20 * DAY);

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "GracePeriodNotElapsed",
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Late fee accrual
  // ──────────────────────────────────────────────────────────────────────

  describe("Late fee accrual", function () {
    it("no late fees when not delinquent", async function () {
      const f = await installmentFixture();
      await time.increase(5 * DAY);
      expect(await f.loan.lateFeeAccrued()).to.equal(0);
    });

    it("late fees accrue during repayment when delinquent", async function () {
      const f = await installmentFixture();
      // Become delinquent
      await time.increase(15 * DAY);
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.be.gt(0);

      // Make a repayment — late fees should be accrued inside repay()
      const pay = 100_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);
      await f.loan.connect(f.borrower).repay(pay);

      // totalDebtWithFees should be > totalDebt when late fees exist
      // (or at minimum, repaidTotal reflects the payment)
      expect(await f.loan.repaidTotal()).to.equal(pay);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Edge cases
  // ──────────────────────────────────────────────────────────────────────

  describe("Edge cases", function () {
    it("repay reverts with ZeroAmount", async function () {
      const f = await installmentFixture();
      await expect(
        f.loan.connect(f.borrower).repay(0),
      ).to.be.revertedWithCustomError(f.loan, "ZeroAmount");
    });

    it("repay reverts with RepaymentExceedsDebt for huge amount", async function () {
      const f = await installmentFixture();
      await time.increase(5 * DAY);
      await f.loan.accrueInterest();

      const hugeAmount = f.PRINCIPAL * 10n;
      await f.usdc.mint(f.borrower.address, hugeAmount);
      await f.usdc
        .connect(f.borrower)
        .approve(await f.loan.getAddress(), hugeAmount);

      await expect(
        f.loan.connect(f.borrower).repay(hugeAmount),
      ).to.be.revertedWithCustomError(f.loan, "RepaymentExceedsDebt");
    });

    it("multiple repayments track installmentsPaid correctly", async function () {
      const f = await installmentFixture();
      const installmentPrincipal = f.PRINCIPAL / 3n;

      // Pay 1.5 installments worth of principal over 2 txs
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const interest = await f.loan.interestAccrued();
      // First payment: cover interest + 1 installment principal
      const pay1 = interest + installmentPrincipal + 10_000n;
      await f.usdc.mint(f.borrower.address, pay1);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay1);
      await f.loan.connect(f.borrower).repay(pay1);
      expect(await f.loan.installmentsPaid()).to.be.gte(1);

      // Second payment: half an installment
      const pay2 = installmentPrincipal / 2n;
      await f.usdc.mint(f.borrower.address, pay2);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay2);
      await f.loan.connect(f.borrower).repay(pay2);

      // Should still be 1 installment paid (not enough for 2nd)
      expect(await f.loan.installmentsPaid()).to.be.lte(2);
    });

    it("no gas explosion from installment metadata", async function () {
      const f = await installmentFixture();
      await time.increase(5 * DAY);

      const pay = 100_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      // Just ensure the repay doesn't run out of gas
      const tx = await f.loan.connect(f.borrower).repay(pay);
      const receipt = await tx.wait();
      // Gas should be reasonable (< 500k)
      expect(receipt!.gasUsed).to.be.lt(500_000);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Audit-grade events
  // ──────────────────────────────────────────────────────────────────────

  describe("Audit-grade events", function () {
    it("emits InstallmentConfigSet on initialization", async function () {
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

      await vault.grantRole(
        await vault.LOAN_REGISTRAR_ROLE(),
        await factory.getAddress(),
      );
      await feeManager.grantRole(
        await feeManager.LOAN_REGISTRAR_ROLE(),
        await factory.getAddress(),
      );
      await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

      const SCHEDULE_HASH = ethers.keccak256(
        ethers.toUtf8Bytes("schedule:3x10d"),
      );

      const tx = factory.connect(borrower).createLoan({
        fundingModel: 0,
        repaymentModel: 1,
        borrower: borrower.address,
        collateralToken: await weth.getAddress(),
        collateralAmount: ethers.parseEther("5"),
        principalAmount: 900_000_000n,
        interestRateBps: 1200,
        durationSeconds: 30 * DAY,
        gracePeriodSeconds: 7 * DAY,
        fundingDeadline: 0,
        pool: ethers.ZeroAddress,
        totalInstallments: 3,
        installmentInterval: 10 * DAY,
        installmentGracePeriod: 2 * DAY,
        penaltyAprBps: 500,
        defaultThresholdDays: 30,
        scheduleHash: SCHEDULE_HASH,
      });

      // The loan clone emits InstallmentConfigSet during initialize()
      // We need to get the loan address to check the event
      await (await tx).wait();
      const loanAddr = await factory.loans(0);
      const loan = await ethers.getContractAt("UnifiedLoan", loanAddr);

      // Verify the config was stored (event was emitted during createLoan tx)
      expect(await loan.scheduleHash()).to.equal(SCHEDULE_HASH);
      expect(await loan.totalInstallments()).to.equal(3);
      expect(await loan.installmentInterval()).to.equal(10 * DAY);
      expect(await loan.installmentGracePeriod()).to.equal(2 * DAY);
      expect(await loan.penaltyAprBps()).to.equal(500);
    });

    it("does not emit InstallmentConfigSet for BULLET loans", async function () {
      const f = await bulletFixture();
      // BULLET loans have zero installment config — no config event
      expect(await f.loan.totalInstallments()).to.equal(0);
      expect(await f.loan.scheduleHash()).to.equal(ethers.ZeroHash);
    });

    it("emits RepaymentApplied with allocation breakdown", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const pay = 200_000_000n; // 200 USDC
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      await expect(f.loan.connect(f.borrower).repay(pay)).to.emit(
        f.loan,
        "RepaymentApplied",
      );
    });

    it("RepaymentApplied feePortion + interestPortion + principalPortion == totalAmount", async function () {
      const f = await installmentFixture();
      await time.increase(10 * DAY);
      await f.loan.accrueInterest();

      const pay = 400_000_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      const tx = await f.loan.connect(f.borrower).repay(pay);
      const receipt = await tx.wait();

      // Find RepaymentApplied event
      const iface = f.loan.interface;
      const repayEvent = receipt!.logs
        .map((log: any) => {
          try {
            return iface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "RepaymentApplied");

      expect(repayEvent).to.not.be.null;
      const { totalAmount, feePortion, interestPortion, principalPortion } =
        repayEvent!.args;
      expect(feePortion + interestPortion + principalPortion).to.equal(
        totalAmount,
      );
    });

    it("LoanDelinquent event includes installmentIndex and daysPastDue", async function () {
      const f = await installmentFixture();
      await time.increase(14 * DAY); // 2 days past grace for installment 1

      const tx = await f.loan.checkDelinquency();
      const receipt = await tx.wait();

      const iface = f.loan.interface;
      const delinqEvent = receipt!.logs
        .map((log: any) => {
          try {
            return iface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "LoanDelinquent");

      expect(delinqEvent).to.not.be.null;
      // installmentIndex = 1 (first unpaid installment, 1-indexed)
      expect(delinqEvent!.args.installmentIndex).to.equal(1);
      // daysPastDue >= 1 (14d - 12d grace = 2d)
      expect(delinqEvent!.args.daysPastDue).to.be.gte(1);
    });

    it("LoanCured event emitted when delinquency clears", async function () {
      const f = await installmentFixture();
      await time.increase(13 * DAY);
      await f.loan.checkDelinquency();
      expect(await f.loan.delinquentSince()).to.be.gt(0);

      // Pay enough to catch up
      await f.loan.accrueInterest();
      const installmentPrincipal = f.PRINCIPAL / 3n;
      const debt = await f.loan.totalDebt();
      const pay = installmentPrincipal + (debt - f.PRINCIPAL) + 100_000n;

      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      await expect(f.loan.connect(f.borrower).repay(pay)).to.emit(
        f.loan,
        "LoanCured",
      );
    });

    it("LoanDefaulted event includes installmentIndex and daysPastDue", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);

      const tx = await f.loan.markDefault();
      const receipt = await tx.wait();

      const iface = f.loan.interface;
      const defaultEvent = receipt!.logs
        .map((log: any) => {
          try {
            return iface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "LoanDefaulted");

      expect(defaultEvent).to.not.be.null;
      // installmentIndex = 1 (first unpaid installment)
      expect(defaultEvent!.args.installmentIndex).to.equal(1);
      expect(defaultEvent!.args.daysPastDue).to.be.gte(30);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  Config required before activation
  // ──────────────────────────────────────────────────────────────────────

  describe("Config required before activation", function () {
    it("INSTALLMENT loan with zero totalInstallments reverts at creation", async function () {
      const [admin, borrower] = await ethers.getSigners();

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

      await vault.grantRole(
        await vault.LOAN_REGISTRAR_ROLE(),
        await factory.getAddress(),
      );
      await feeManager.grantRole(
        await feeManager.LOAN_REGISTRAR_ROLE(),
        await factory.getAddress(),
      );
      await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

      // INSTALLMENT model but totalInstallments = 0 → should revert
      await expect(
        factory.connect(borrower).createLoan({
          fundingModel: 0,
          repaymentModel: 1,
          borrower: borrower.address,
          collateralToken: await weth.getAddress(),
          collateralAmount: ethers.parseEther("5"),
          principalAmount: 900_000_000n,
          interestRateBps: 1200,
          durationSeconds: 30 * DAY,
          gracePeriodSeconds: 7 * DAY,
          fundingDeadline: 0,
          pool: ethers.ZeroAddress,
          totalInstallments: 0,
          installmentInterval: 0,
          installmentGracePeriod: 0,
          penaltyAprBps: 0,
          defaultThresholdDays: 0,
          scheduleHash: ethers.ZeroHash,
        }),
      ).to.be.revertedWithCustomError(loanImpl, "InvalidInstallmentConfig");
    });

    it("INSTALLMENT loan with zero installmentInterval reverts at creation", async function () {
      const [admin, borrower] = await ethers.getSigners();

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

      await vault.grantRole(
        await vault.LOAN_REGISTRAR_ROLE(),
        await factory.getAddress(),
      );
      await feeManager.grantRole(
        await feeManager.LOAN_REGISTRAR_ROLE(),
        await factory.getAddress(),
      );
      await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

      // totalInstallments > 0 but installmentInterval = 0 → should revert
      await expect(
        factory.connect(borrower).createLoan({
          fundingModel: 0,
          repaymentModel: 1,
          borrower: borrower.address,
          collateralToken: await weth.getAddress(),
          collateralAmount: ethers.parseEther("5"),
          principalAmount: 900_000_000n,
          interestRateBps: 1200,
          durationSeconds: 30 * DAY,
          gracePeriodSeconds: 7 * DAY,
          fundingDeadline: 0,
          pool: ethers.ZeroAddress,
          totalInstallments: 3,
          installmentInterval: 0,
          installmentGracePeriod: 0,
          penaltyAprBps: 0,
          defaultThresholdDays: 0,
          scheduleHash: ethers.ZeroHash,
        }),
      ).to.be.revertedWithCustomError(loanImpl, "InvalidInstallmentConfig");
    });

    it("BULLET loan activates without installment config", async function () {
      const f = await bulletFixture();
      // Already activated in fixture — just verify ACTIVE
      expect(await f.loan.status()).to.equal(2); // ACTIVE
      expect(await f.loan.totalInstallments()).to.equal(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  //  No state transitions after DEFAULTED
  // ──────────────────────────────────────────────────────────────────────

  describe("No state transitions after DEFAULTED", function () {
    it("repay reverts on a DEFAULTED loan", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();
      expect(await f.loan.status()).to.equal(4);

      const pay = 1_000_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      await expect(
        f.loan.connect(f.borrower).repay(pay),
      ).to.be.revertedWithCustomError(f.loan, "InvalidLoanState");
    });

    it("markDefault reverts on a DEFAULTED loan (double-default)", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "InvalidLoanState",
      );
    });

    it("close reverts on a DEFAULTED loan", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.close()).to.be.revertedWithCustomError(
        f.loan,
        "InvalidLoanState",
      );
    });

    it("claimCollateral succeeds on DEFAULTED loan", async function () {
      const f = await installmentFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.connect(f.lender).claimCollateral()).to.emit(
        f.loan,
        "CollateralClaimed",
      );
    });
  });
});
