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

// ═══════════════════════════════════════════════════════════════════════════
//  Fixtures
// ═══════════════════════════════════════════════════════════════════════════

/** Deploy infrastructure common to all fixtures. */
async function deployInfra() {
  const [admin, borrower, lender, lender2, stranger] =
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

  await vault.grantRole(
    await vault.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await feeManager.grantRole(
    await feeManager.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  return {
    admin,
    borrower,
    lender,
    lender2,
    stranger,
    usdc,
    weth,
    vault,
    factory,
    loanImpl,
    treasury,
    feeManager,
  };
}

/** DIRECT + INSTALLMENT loan — activated, ready for default tests. */
async function installmentDirectFixture() {
  const infra = await deployInfra();
  const PRINCIPAL = 900_000_000n;
  const COLLATERAL = ethers.parseEther("5");

  const params = {
    fundingModel: 0,
    repaymentModel: 1,
    borrower: infra.borrower.address,
    collateralToken: await infra.weth.getAddress(),
    collateralAmount: COLLATERAL,
    principalAmount: PRINCIPAL,
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
    scheduleHash: ethers.keccak256(ethers.toUtf8Bytes("schedule:3x10d")),
  };

  await infra.factory.connect(infra.borrower).createLoan(params);
  const loanAddress = await infra.factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  await infra.usdc.mint(infra.lender.address, PRINCIPAL);
  await infra.usdc.connect(infra.lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(infra.lender).fund(PRINCIPAL);

  await infra.weth.mint(infra.borrower.address, COLLATERAL);
  await infra.weth
    .connect(infra.borrower)
    .approve(await infra.vault.getAddress(), COLLATERAL);
  await loan.connect(infra.borrower).lockCollateral();
  await loan.connect(infra.lender).activateAndDisburse();

  return { ...infra, loan, PRINCIPAL, COLLATERAL, params };
}

/** DIRECT + BULLET loan — activated, ready for default tests. */
async function bulletDirectFixture() {
  const infra = await deployInfra();
  const PRINCIPAL = 10_000_000n;
  const COLLATERAL = ethers.parseEther("5");

  const params = {
    fundingModel: 0,
    repaymentModel: 0,
    borrower: infra.borrower.address,
    collateralToken: await infra.weth.getAddress(),
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

  await infra.factory.connect(infra.borrower).createLoan(params);
  const loanAddress = await infra.factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  await infra.usdc.mint(infra.lender.address, PRINCIPAL);
  await infra.usdc.connect(infra.lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(infra.lender).fund(PRINCIPAL);

  await infra.weth.mint(infra.borrower.address, COLLATERAL);
  await infra.weth
    .connect(infra.borrower)
    .approve(await infra.vault.getAddress(), COLLATERAL);
  await loan.connect(infra.borrower).lockCollateral();
  await loan.connect(infra.lender).activateAndDisburse();

  return { ...infra, loan, PRINCIPAL, COLLATERAL, params };
}

/** CROWDFUND loan — 2 lenders, activated, ready for default + pro-rata claim tests. */
async function crowdfundFixture() {
  const infra = await deployInfra();
  const PRINCIPAL = 900_000_000n;
  const COLLATERAL = ethers.parseEther("6");
  const LENDER1_SHARE = 600_000_000n; // 2/3
  const LENDER2_SHARE = 300_000_000n; // 1/3

  const params = {
    fundingModel: 1, // CROWDFUND
    repaymentModel: 0, // BULLET
    borrower: infra.borrower.address,
    collateralToken: await infra.weth.getAddress(),
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

  await infra.factory.connect(infra.borrower).createLoan(params);
  const loanAddress = await infra.factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  // Lender 1: 600 USDC
  await infra.usdc.mint(infra.lender.address, LENDER1_SHARE);
  await infra.usdc.connect(infra.lender).approve(loanAddress, LENDER1_SHARE);
  await loan.connect(infra.lender).fund(LENDER1_SHARE);

  // Lender 2: 300 USDC
  await infra.usdc.mint(infra.lender2.address, LENDER2_SHARE);
  await infra.usdc.connect(infra.lender2).approve(loanAddress, LENDER2_SHARE);
  await loan.connect(infra.lender2).fund(LENDER2_SHARE);

  await infra.weth.mint(infra.borrower.address, COLLATERAL);
  await infra.weth
    .connect(infra.borrower)
    .approve(await infra.vault.getAddress(), COLLATERAL);
  await loan.connect(infra.borrower).lockCollateral();
  await loan.connect(infra.borrower).activateAndDisburse();

  return {
    ...infra,
    loan,
    PRINCIPAL,
    COLLATERAL,
    LENDER1_SHARE,
    LENDER2_SHARE,
    params,
  };
}

/** POOL model loan — activated, ready for default + pool claim tests. */
async function poolFixture() {
  const infra = await deployInfra();
  const PRINCIPAL = 500_000_000n;
  const COLLATERAL = ethers.parseEther("3");
  const DEPOSIT = 1_000_000_000n;

  const Pool = await ethers.getContractFactory("UnifiedPool");
  const pool = await Pool.deploy(
    infra.admin.address,
    await infra.usdc.getAddress(),
    ethers.encodeBytes32String("default-safety"),
  );
  const poolAddr = await pool.getAddress();

  await pool.grantRole(
    await pool.LOAN_REGISTRAR_ROLE(),
    await infra.factory.getAddress(),
  );
  await timelockExec(infra.factory, "setPool", [poolAddr, true]);

  // Deposit liquidity
  await infra.usdc.mint(infra.lender.address, DEPOSIT);
  await infra.usdc.connect(infra.lender).approve(poolAddr, DEPOSIT);
  await pool.connect(infra.lender).deposit(DEPOSIT);

  const params = {
    fundingModel: 2, // POOL
    repaymentModel: 0, // BULLET
    borrower: infra.borrower.address,
    collateralToken: await infra.weth.getAddress(),
    collateralAmount: COLLATERAL,
    principalAmount: PRINCIPAL,
    interestRateBps: 1200,
    durationSeconds: 30 * DAY,
    gracePeriodSeconds: 7 * DAY,
    fundingDeadline: 0,
    pool: poolAddr,
    totalInstallments: 0,
    installmentInterval: 0,
    installmentGracePeriod: 0,
    penaltyAprBps: 0,
    defaultThresholdDays: 0,
    scheduleHash: ethers.ZeroHash,
  };

  await infra.factory.connect(infra.borrower).createLoan(params);
  const loanAddress = await infra.factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  await infra.weth.mint(infra.borrower.address, COLLATERAL);
  await infra.weth
    .connect(infra.borrower)
    .approve(await infra.vault.getAddress(), COLLATERAL);
  await loan.connect(infra.borrower).lockCollateral();

  await pool.connect(infra.admin).allocateToLoan(loanAddress, PRINCIPAL);
  await loan.connect(infra.borrower).activateAndDisburse();

  return { ...infra, loan, pool, PRINCIPAL, COLLATERAL, params };
}

/** DIRECT + BULLET with settlement agent for fiat-proof tests. */
async function fiatProofFixture() {
  const [admin, borrower, lender, _lender2, settlementAgent] =
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

  await vault.grantRole(
    await vault.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await feeManager.grantRole(
    await feeManager.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

  // Setup settlement agent on the factory
  await timelockSetup([
    {
      contract: factory,
      funcName: "setSettlementAgent",
      args: [settlementAgent.address],
    },
  ]);

  const PRINCIPAL = 10_000_000n;
  const COLLATERAL = ethers.parseEther("5");

  await factory.connect(borrower).createLoan({
    fundingModel: 0,
    repaymentModel: 0,
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
  });

  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  await usdc.mint(lender.address, PRINCIPAL);
  await usdc.connect(lender).approve(loanAddress, PRINCIPAL);
  await loan.connect(lender).fund(PRINCIPAL);

  await weth.mint(borrower.address, COLLATERAL);
  await weth.connect(borrower).approve(await vault.getAddress(), COLLATERAL);
  await loan.connect(borrower).lockCollateral();
  await loan.connect(lender).activateAndDisburse();

  return {
    admin,
    borrower,
    lender,
    settlementAgent,
    usdc,
    weth,
    loan,
    vault,
    PRINCIPAL,
    COLLATERAL,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Default & Post-Default Safety Guarantees", function () {
  // ────────────────────────────────────────────────────────────────────
  //  1. Default Trigger Determinism
  // ────────────────────────────────────────────────────────────────────

  describe("Default trigger determinism — installment", function () {
    it("reverts 1 second before delinquency threshold", async function () {
      const f = await installmentDirectFixture();
      const startTs = await f.loan.startTs();
      // Grace deadline for installment 1 = startTs + 10d + 2d
      const graceDeadline = startTs + BigInt(12 * DAY);
      // Threshold = graceDeadline + 30 days
      const thresholdTs = graceDeadline + BigInt(30 * DAY);

      // Advance to 2 seconds before threshold (time.increaseTo mines a block,
      // so the next tx executes at thresholdTs - 1)
      await time.increaseTo(thresholdTs - 2n);

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "DelinquencyThresholdNotReached",
      );
    });

    it("succeeds at exact delinquency threshold", async function () {
      const f = await installmentDirectFixture();
      const startTs = await f.loan.startTs();
      const graceDeadline = startTs + BigInt(12 * DAY);
      const thresholdTs = graceDeadline + BigInt(30 * DAY);

      await time.increaseTo(thresholdTs);

      await expect(f.loan.markDefault()).to.emit(f.loan, "LoanDefaulted");
      expect(await f.loan.status()).to.equal(4); // DEFAULTED
    });

    it("LoanDefaulted event has correct installmentIndex and daysPastDue", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);

      const tx = await f.loan.markDefault();
      const receipt = await tx.wait();

      const iface = f.loan.interface;
      const evt = receipt!.logs
        .map((l: any) => {
          try {
            return iface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "LoanDefaulted");

      expect(evt).to.not.be.null;
      expect(evt!.args.installmentIndex).to.equal(1); // first unpaid, 1-indexed
      expect(evt!.args.daysPastDue).to.be.gte(30);
    });
  });

  describe("Default trigger determinism — bullet", function () {
    it("reverts 1 second before maturity + grace", async function () {
      const f = await bulletDirectFixture();
      const startTs = await f.loan.startTs();
      const maturity = startTs + BigInt(30 * DAY) + BigInt(7 * DAY);

      await time.increaseTo(maturity - 2n);

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "GracePeriodNotElapsed",
      );
    });

    it("succeeds at exact maturity + grace", async function () {
      const f = await bulletDirectFixture();
      const startTs = await f.loan.startTs();
      const maturity = startTs + BigInt(30 * DAY) + BigInt(7 * DAY);

      await time.increaseTo(maturity);

      await expect(f.loan.markDefault()).to.emit(f.loan, "Defaulted");
      expect(await f.loan.status()).to.equal(4);
    });

    it("emits LoanDefaulted with installmentIndex=0 and daysPastDue", async function () {
      const f = await bulletDirectFixture();
      // Advance to maturity + grace + 5 days
      await time.increase(42 * DAY);

      const tx = await f.loan.markDefault();
      const receipt = await tx.wait();

      const iface = f.loan.interface;
      const evt = receipt!.logs
        .map((l: any) => {
          try {
            return iface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "LoanDefaulted");

      expect(evt).to.not.be.null;
      expect(evt!.args.installmentIndex).to.equal(0); // bullet = 0
      expect(evt!.args.daysPastDue).to.be.gte(4); // ~5 days past maturity
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  2. Post-Default Restrictions
  // ────────────────────────────────────────────────────────────────────

  describe("Post-default restrictions — state transitions", function () {
    it("double-default reverts (installment)", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "InvalidLoanState",
      );
    });

    it("double-default reverts (bullet)", async function () {
      const f = await bulletDirectFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.markDefault()).to.be.revertedWithCustomError(
        f.loan,
        "InvalidLoanState",
      );
    });

    it("repay blocked after default", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      const pay = 1_000_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);

      await expect(
        f.loan.connect(f.borrower).repay(pay),
      ).to.be.revertedWithCustomError(f.loan, "InvalidLoanState");
    });

    it("fund blocked after default", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      const amt = 1_000_000n;
      await f.usdc.mint(f.lender.address, amt);
      await f.usdc.connect(f.lender).approve(await f.loan.getAddress(), amt);

      await expect(
        f.loan.connect(f.lender).fund(amt),
      ).to.be.revertedWithCustomError(f.loan, "InvalidLoanState");
    });

    it("activateAndDisburse blocked after default", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      await expect(
        f.loan.connect(f.lender).activateAndDisburse(),
      ).to.be.revertedWithCustomError(f.loan, "InvalidLoanState");
    });

    it("close blocked after default", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.close()).to.be.revertedWithCustomError(
        f.loan,
        "InvalidLoanState",
      );
    });

    it("no re-entry to ACTIVE from DEFAULTED", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();
      expect(await f.loan.status()).to.equal(4);

      // No path back to ACTIVE — verify after claim
      await f.loan.connect(f.lender).claimCollateral();
      expect(await f.loan.status()).to.equal(5); // CLOSED, not ACTIVE
    });
  });

  describe("Post-default restrictions — fiat proofs", function () {
    it("recordFiatDisbursement reverts on DEFAULTED loan", async function () {
      const f = await fiatProofFixture();
      // Default the loan
      await time.increase(38 * DAY);
      await f.loan.markDefault();
      expect(await f.loan.status()).to.equal(4);

      const ref = ethers.keccak256(ethers.toUtf8Bytes("disburse:post-default"));
      await expect(
        f.loan.connect(f.settlementAgent).recordFiatDisbursement(ref),
      ).to.be.revertedWithCustomError(f.loan, "LoanTerminated");
    });

    it("recordFiatRepayment reverts on DEFAULTED loan", async function () {
      const f = await fiatProofFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      const ref = ethers.keccak256(ethers.toUtf8Bytes("repay:post-default"));
      await expect(
        f.loan.connect(f.settlementAgent).recordFiatRepayment(ref),
      ).to.be.revertedWithCustomError(f.loan, "LoanTerminated");
    });

    it("recordFiatRepayment reverts on CLOSED loan", async function () {
      const f = await fiatProofFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();
      await f.loan.connect(f.lender).claimCollateral();
      expect(await f.loan.status()).to.equal(5); // CLOSED

      const ref = ethers.keccak256(ethers.toUtf8Bytes("repay:post-close"));
      await expect(
        f.loan.connect(f.settlementAgent).recordFiatRepayment(ref),
      ).to.be.revertedWithCustomError(f.loan, "LoanTerminated");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  3. Collateral Claim Path Safety
  // ────────────────────────────────────────────────────────────────────

  describe("Collateral claim — DIRECT", function () {
    it("lender claims full collateral amount", async function () {
      const f = await bulletDirectFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      const lenderWethBefore = await f.weth.balanceOf(f.lender.address);
      await f.loan.connect(f.lender).claimCollateral();
      const lenderWethAfter = await f.weth.balanceOf(f.lender.address);

      expect(lenderWethAfter - lenderWethBefore).to.equal(f.COLLATERAL);
    });

    it("collateralClaimedTotal equals collateralAmount after claim", async function () {
      const f = await bulletDirectFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();
      await f.loan.connect(f.lender).claimCollateral();

      expect(await f.loan.collateralClaimedTotal()).to.equal(f.COLLATERAL);
    });

    it("double-claim impossible — transitions to CLOSED", async function () {
      const f = await bulletDirectFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();
      await f.loan.connect(f.lender).claimCollateral();
      expect(await f.loan.status()).to.equal(5); // CLOSED

      await expect(
        f.loan.connect(f.lender).claimCollateral(),
      ).to.be.revertedWithCustomError(f.loan, "InvalidLoanState");
    });

    it("non-lender cannot claim", async function () {
      const f = await bulletDirectFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await expect(
        f.loan.connect(f.stranger).claimCollateral(),
      ).to.be.revertedWithCustomError(f.loan, "NotALender");
    });
  });

  describe("Collateral claim — CROWDFUND pro-rata", function () {
    it("two lenders receive correct pro-rata shares", async function () {
      const f = await crowdfundFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      // Lender 1 contributed 600/900 = 2/3
      const expectedShare1 = (f.COLLATERAL * f.LENDER1_SHARE) / f.PRINCIPAL;
      // Lender 2 contributed 300/900 = 1/3
      const expectedShare2 = (f.COLLATERAL * f.LENDER2_SHARE) / f.PRINCIPAL;

      const l1Before = await f.weth.balanceOf(f.lender.address);
      await f.loan.connect(f.lender).claimCollateral();
      const l1After = await f.weth.balanceOf(f.lender.address);
      expect(l1After - l1Before).to.equal(expectedShare1);

      const l2Before = await f.weth.balanceOf(f.lender2.address);
      await f.loan.connect(f.lender2).claimCollateral();
      const l2After = await f.weth.balanceOf(f.lender2.address);
      expect(l2After - l2Before).to.equal(expectedShare2);

      // Verify total claimed == collateral
      expect(await f.loan.collateralClaimedTotal()).to.equal(f.COLLATERAL);
    });

    it("double-claim by same lender reverts", async function () {
      const f = await crowdfundFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await f.loan.connect(f.lender).claimCollateral();

      // contribution zeroed out → NotALender
      await expect(
        f.loan.connect(f.lender).claimCollateral(),
      ).to.be.revertedWithCustomError(f.loan, "NotALender");
    });

    it("auto-closes after all lenders claim", async function () {
      const f = await crowdfundFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      // Still DEFAULTED after first claim (vault not empty)
      await f.loan.connect(f.lender).claimCollateral();
      expect(await f.loan.status()).to.equal(4); // still DEFAULTED

      // Second lender drains the vault → CLOSED
      await f.loan.connect(f.lender2).claimCollateral();
      expect(await f.loan.status()).to.equal(5); // CLOSED
    });

    it("non-contributing address cannot claim", async function () {
      const f = await crowdfundFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await expect(
        f.loan.connect(f.stranger).claimCollateral(),
      ).to.be.revertedWithCustomError(f.loan, "NotALender");
    });
  });

  describe("Collateral claim — POOL", function () {
    it("pool claims full collateral", async function () {
      const f = await poolFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      const poolAddr = await f.pool.getAddress();
      const loanAddr = await f.loan.getAddress();
      const poolWethBefore = await f.weth.balanceOf(poolAddr);
      await f.pool.connect(f.admin).claimLoanCollateral(loanAddr);
      const poolWethAfter = await f.weth.balanceOf(poolAddr);

      expect(poolWethAfter - poolWethBefore).to.equal(f.COLLATERAL);
      expect(await f.loan.collateralClaimedTotal()).to.equal(f.COLLATERAL);
      expect(await f.loan.status()).to.equal(5); // CLOSED
    });

    it("double-claim impossible — status is CLOSED", async function () {
      const f = await poolFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      const loanAddr = await f.loan.getAddress();
      await f.pool.connect(f.admin).claimLoanCollateral(loanAddr);
      expect(await f.loan.status()).to.equal(5); // CLOSED

      // Second claim reverts — loan is now CLOSED, not DEFAULTED
      await expect(f.pool.connect(f.admin).claimLoanCollateral(loanAddr)).to.be
        .reverted;
    });

    it("non-pool address cannot claim", async function () {
      const f = await poolFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await expect(
        f.loan.connect(f.lender).claimCollateral(),
      ).to.be.revertedWithCustomError(f.loan, "Unauthorized");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  4. Pause + Default Safety (no trapped funds)
  // ────────────────────────────────────────────────────────────────────

  describe("Pause + default — no trapped funds", function () {
    it("markDefault succeeds while paused", async function () {
      const f = await bulletDirectFixture();
      // Pause the loan via the factory (pauser is factory address)
      const loanAddr = await f.loan.getAddress();
      await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);
      expect(await f.loan.loanPaused()).to.be.true;

      await time.increase(38 * DAY);
      await expect(f.loan.markDefault()).to.emit(f.loan, "Defaulted");
      expect(await f.loan.status()).to.equal(4);
    });

    it("claimCollateral succeeds while paused", async function () {
      const f = await bulletDirectFixture();
      const loanAddr = await f.loan.getAddress();
      await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await expect(f.loan.connect(f.lender).claimCollateral()).to.emit(
        f.loan,
        "CollateralClaimed",
      );
      expect(await f.loan.status()).to.equal(5);
    });

    it("pause + default + claim full lifecycle", async function () {
      const f = await installmentDirectFixture();
      // Pause midway via factory
      await time.increase(15 * DAY);
      const loanAddr = await f.loan.getAddress();
      await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);

      // Default still triggers even while paused
      await time.increase(28 * DAY); // 43 days total — past threshold
      await f.loan.markDefault();
      expect(await f.loan.status()).to.equal(4);

      // Claim while still paused
      const lenderWethBefore = await f.weth.balanceOf(f.lender.address);
      await f.loan.connect(f.lender).claimCollateral();
      const lenderWethAfter = await f.weth.balanceOf(f.lender.address);

      expect(lenderWethAfter - lenderWethBefore).to.equal(f.COLLATERAL);
      expect(await f.loan.status()).to.equal(5); // CLOSED
    });

    it("CROWDFUND: pause + default + all lenders claim", async function () {
      const f = await crowdfundFixture();
      const loanAddr = await f.loan.getAddress();
      await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      // Both lenders claim while paused
      await f.loan.connect(f.lender).claimCollateral();
      await f.loan.connect(f.lender2).claimCollateral();

      expect(await f.loan.status()).to.equal(5);
      expect(await f.loan.collateralClaimedTotal()).to.equal(f.COLLATERAL);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  //  5. Accounting Invariants
  // ────────────────────────────────────────────────────────────────────

  describe("Accounting invariants", function () {
    it("collateralClaimedTotal never exceeds collateralAmount", async function () {
      const f = await crowdfundFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await f.loan.connect(f.lender).claimCollateral();
      expect(await f.loan.collateralClaimedTotal()).to.be.lte(f.COLLATERAL);

      await f.loan.connect(f.lender2).claimCollateral();
      expect(await f.loan.collateralClaimedTotal()).to.be.lte(f.COLLATERAL);
    });

    it("vault balance reaches zero after full claims", async function () {
      const f = await bulletDirectFixture();
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      await f.loan.connect(f.lender).claimCollateral();

      const vault = await ethers.getContractAt(
        "UnifiedCollateralVault",
        await f.loan.collateralVault(),
      );
      const [, , remaining] = await vault.lockedByLoan(
        await f.loan.getAddress(),
      );
      expect(remaining).to.equal(0);
    });

    it("interest and late fees accrued before default are preserved", async function () {
      const f = await installmentDirectFixture();
      await time.increase(43 * DAY);
      await f.loan.markDefault();

      // Post-default interest should have been accrued
      expect(await f.loan.interestAccrued()).to.be.gt(0);
      // Late fees should have been accrued (delinquent for >30 days)
      expect(await f.loan.lateFeeAccrued()).to.be.gt(0);
    });

    it("repaidTotal is preserved through default", async function () {
      const f = await installmentDirectFixture();

      // Make a partial payment
      await time.increase(5 * DAY);
      const pay = 100_000_000n;
      await f.usdc.mint(f.borrower.address, pay);
      await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), pay);
      await f.loan.connect(f.borrower).repay(pay);
      expect(await f.loan.repaidTotal()).to.equal(pay);

      // Default
      await time.increase(38 * DAY);
      await f.loan.markDefault();

      // repaidTotal unchanged
      expect(await f.loan.repaidTotal()).to.equal(pay);
    });
  });
});
