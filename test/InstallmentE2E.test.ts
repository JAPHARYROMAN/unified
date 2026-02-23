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

async function directInstallmentFixture() {
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

  const principal = 900_000_000n; // 900 USDC
  const params = {
    fundingModel: 0, // DIRECT
    repaymentModel: 1, // INSTALLMENT
    borrower: borrower.address,
    collateralToken: await weth.getAddress(),
    collateralAmount: ethers.parseEther("5"),
    principalAmount: principal,
    interestRateBps: 1200, // 12%
    durationSeconds: 30 * DAY,
    gracePeriodSeconds: 7 * DAY,
    fundingDeadline: 0,
    pool: ethers.ZeroAddress,
    totalInstallments: 3,
    installmentInterval: 10 * DAY,
    installmentGracePeriod: 3 * DAY,
    penaltyAprBps: 1800,
    defaultThresholdDays: 31,
    scheduleHash: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "uint256", "uint256"],
        [3, 10 * DAY, 3 * DAY, 1800, 31],
      ),
    ),
  };

  await factory.connect(borrower).createLoan(params);
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  await usdc.mint(lender.address, principal);
  await usdc.connect(lender).approve(loanAddress, principal);
  await loan.connect(lender).fund(principal);

  await weth.mint(borrower.address, params.collateralAmount);
  await weth
    .connect(borrower)
    .approve(await vault.getAddress(), params.collateralAmount);
  await loan.connect(borrower).lockCollateral();
  await loan.connect(borrower).activateAndDisburse();

  return {
    admin,
    borrower,
    lender,
    usdc,
    loan,
    principal,
    totalInstallments: params.totalInstallments,
    installmentInterval: params.installmentInterval,
    installmentGracePeriod: params.installmentGracePeriod,
    defaultThresholdDays: params.defaultThresholdDays,
    duration: params.durationSeconds,
    grace: params.gracePeriodSeconds,
  };
}

async function poolInstallmentFixture() {
  const [admin, depositor, borrower] = await ethers.getSigners();

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

  const Pool = await ethers.getContractFactory("UnifiedPool");
  const pool = await Pool.deploy(
    admin.address,
    await usdc.getAddress(),
    ethers.encodeBytes32String("installment"),
  );
  const poolAddr = await pool.getAddress();

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
  await pool.grantRole(
    await pool.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);
  await timelockExec(factory, "setPool", [poolAddr, true]);

  const deposit = 1_000_000_000n; // 1000 USDC
  const principal = 500_000_000n; // 500 USDC
  await usdc.mint(depositor.address, deposit);
  await usdc.connect(depositor).approve(poolAddr, deposit);
  await pool.connect(depositor).deposit(deposit);

  await factory.connect(borrower).createLoan({
    fundingModel: 2, // POOL
    repaymentModel: 1, // INSTALLMENT
    borrower: borrower.address,
    collateralToken: await weth.getAddress(),
    collateralAmount: ethers.parseEther("3"),
    principalAmount: principal,
    interestRateBps: 1200,
    durationSeconds: 30 * DAY,
    gracePeriodSeconds: 7 * DAY,
    fundingDeadline: 0,
    pool: poolAddr,
    totalInstallments: 3,
    installmentInterval: 10 * DAY,
    installmentGracePeriod: 3 * DAY,
    penaltyAprBps: 1800,
    defaultThresholdDays: 31,
    scheduleHash: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "uint256", "uint256"],
        [3, 10 * DAY, 3 * DAY, 1800, 31],
      ),
    ),
  });

  const loanAddr = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddr);
  await weth.mint(borrower.address, ethers.parseEther("3"));
  await weth
    .connect(borrower)
    .approve(await vault.getAddress(), ethers.parseEther("3"));
  await loan.connect(borrower).lockCollateral();

  await pool.connect(admin).allocateToLoan(loanAddr, principal);
  await loan.connect(borrower).activateAndDisburse();

  return { borrower, usdc, pool, loan, principal };
}

describe("Unified v1.1 — Installment E2E Stress Testing", function () {
  it("1) on-time installment payment", async function () {
    const f = await directInstallmentFixture();

    await time.increase(8 * DAY);
    await f.loan.accrueInterest();
    const debtBefore = await f.loan.totalDebtWithFees();
    const installmentPrincipal = f.principal / BigInt(f.totalInstallments);
    const installment = installmentPrincipal + (await f.loan.interestAccrued());

    await f.usdc.mint(f.borrower.address, installment);
    await f.usdc
      .connect(f.borrower)
      .approve(await f.loan.getAddress(), installment);
    await f.loan.connect(f.borrower).repay(installment);

    const debtAfter = await f.loan.totalDebtWithFees();
    expect(debtAfter).to.be.lt(debtBefore);
    expect(await f.loan.installmentsPaid()).to.equal(1);
    expect(await f.loan.lateFeeAccrued()).to.equal(0);
    expect(await f.loan.delinquentSince()).to.equal(0);
    expect(await f.loan.status()).to.equal(2); // ACTIVE
  });

  it("2) payment during grace period", async function () {
    const f = await directInstallmentFixture();

    await time.increase(11 * DAY); // due(10d) + 1d, still within installment grace(3d)
    await f.loan.checkDelinquency();
    await f.loan.accrueInterest();
    const amount = (await f.loan.totalDebtWithFees()) / 4n;

    await f.usdc.mint(f.borrower.address, amount);
    await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), amount);
    await expect(f.loan.connect(f.borrower).repay(amount)).to.emit(
      f.loan,
      "Repaid",
    );
    expect(await f.loan.lateFeeAccrued()).to.equal(0);
    expect(await f.loan.delinquentSince()).to.equal(0);
    expect(await f.loan.status()).to.equal(2); // ACTIVE
  });

  it("3) late payment accrues penalty and applies penalty first", async function () {
    const f = await directInstallmentFixture();

    await time.increase(25 * DAY); // beyond due+grace for installment #1
    await f.loan.checkDelinquency();
    await time.increase(10 * DAY); // allow penalty window to accrue
    const principalBefore = await f.loan.principalOutstanding();
    const amount = 100_000n; // small payment: should be absorbed by late fee first

    await f.usdc.mint(f.borrower.address, amount);
    await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), amount);
    const tx = await f.loan.connect(f.borrower).repay(amount);
    await expect(tx).to.emit(
      f.loan,
      "Repaid",
    );

    const receipt = await tx.wait();
    const repApplied = receipt!.logs
      .map((l: any) => {
        try {
          return f.loan.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "RepaymentApplied");
    expect(repApplied).to.not.equal(undefined);
    expect(repApplied!.args[2]).to.be.gt(0); // lateFeePaid
    expect(repApplied!.args[3]).to.equal(0); // interestPaid
    expect(repApplied!.args[4]).to.equal(0); // principalPaid
    expect(await f.loan.principalOutstanding()).to.equal(principalBefore);
    expect(await f.loan.status()).to.equal(2); // ACTIVE
  });

  it("4) payment 31 days late -> default triggered", async function () {
    const f = await directInstallmentFixture();

    await time.increase(25 * DAY);
    await f.loan.checkDelinquency();
    await time.increase((Number(f.defaultThresholdDays) + 1) * DAY);
    await expect(f.loan.markDefault()).to.emit(f.loan, "Defaulted");
    expect(await f.loan.status()).to.equal(4); // DEFAULTED
  });

  it("5) partial installment payment", async function () {
    const f = await directInstallmentFixture();

    await time.increase(26 * DAY); // delinquent window
    await f.loan.checkDelinquency();
    await f.loan.accrueInterest();
    const installment = f.principal / BigInt(f.totalInstallments);
    const partial = installment / 4n;

    await f.usdc.mint(f.borrower.address, partial);
    await f.usdc
      .connect(f.borrower)
      .approve(await f.loan.getAddress(), partial);
    await f.loan.connect(f.borrower).repay(partial);

    expect(await f.loan.delinquentSince()).to.be.gt(0);
    expect(await f.loan.installmentsPaid()).to.equal(0);
    expect(await f.loan.repaidTotal()).to.equal(partial);
    expect(await f.loan.status()).to.equal(2); // ACTIVE
  });

  it("6) overpayment attempt reverts", async function () {
    const f = await directInstallmentFixture();

    await time.increase(5 * DAY);
    await f.loan.accrueInterest();
    const debt = await f.loan.totalDebt();
    // Use 2x debt to guarantee overpayment (accounts for 1s of interest accrual between calls)
    const over = debt * 2n;

    await f.usdc.mint(f.borrower.address, over);
    await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), over);
    await expect(
      f.loan.connect(f.borrower).repay(over),
    ).to.be.revertedWithCustomError(f.loan, "RepaymentExceedsDebt");
  });

  it("7) multiple installments partially paid with no state corruption", async function () {
    const f = await directInstallmentFixture();

    await time.increase(8 * DAY);
    await f.loan.accrueInterest();
    const d1 = await f.loan.totalDebt();
    const p1 = d1 / 5n;
    await f.usdc.mint(f.borrower.address, p1);
    await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), p1);
    await f.loan.connect(f.borrower).repay(p1);

    await time.increase(8 * DAY);
    await f.loan.accrueInterest();
    const d2 = await f.loan.totalDebt();
    const p2 = d2 / 4n;
    await f.usdc.mint(f.borrower.address, p2);
    await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), p2);
    await f.loan.connect(f.borrower).repay(p2);

    await time.increase(6 * DAY);
    await f.loan.accrueInterest();
    const d3 = await f.loan.totalDebt();
    const p3 = d3 / 3n;
    await f.usdc.mint(f.borrower.address, p3);
    await f.usdc.connect(f.borrower).approve(await f.loan.getAddress(), p3);
    await f.loan.connect(f.borrower).repay(p3);

    expect(await f.loan.status()).to.equal(2); // ACTIVE
    expect(await f.loan.principalOutstanding()).to.be.lte(f.principal);
    expect(await f.loan.interestAccrued()).to.be.gte(0);
  });

  it("8) default -> collateral claim", async function () {
    const f = await directInstallmentFixture();

    await time.increase(25 * DAY);
    await f.loan.checkDelinquency();
    await time.increase((Number(f.defaultThresholdDays) + 1) * DAY);
    await f.loan.markDefault();
    await expect(f.loan.connect(f.lender).claimCollateral()).to.emit(
      f.loan,
      "CollateralClaimed",
    );
    expect(await f.loan.status()).to.equal(5); // CLOSED
  });

  it("NAV updates correctly under installment repayments (POOL model)", async function () {
    const f = await poolInstallmentFixture();
    const navBefore = await f.pool.totalAssetsNAV();
    const outstandingBefore = await f.pool.totalPrincipalOutstanding();

    await time.increase(10 * DAY);
    await f.loan.accrueInterest();
    const repayAmount = 200_000_000n; // 200 USDC
    await f.usdc.mint(f.borrower.address, repayAmount);
    await f.usdc
      .connect(f.borrower)
      .approve(await f.loan.getAddress(), repayAmount);
    await f.loan.connect(f.borrower).repay(repayAmount);

    const navAfter = await f.pool.totalAssetsNAV();
    const outstandingAfter = await f.pool.totalPrincipalOutstanding();

    expect(navAfter).to.be.gte(navBefore);
    expect(outstandingAfter).to.be.lt(outstandingBefore);
  });

  it("emits deterministic installment stress manifest", async function () {
    const f = await directInstallmentFixture();
    const loanAddr = await f.loan.getAddress();

    const stateSnapshots: Array<Record<string, string | number | boolean>> = [];
    const txHashes: string[] = [];

    const pushState = async (label: string) => {
      stateSnapshots.push({
        label,
        at: Number(await time.latest()),
        status: Number(await f.loan.status()),
        installmentsPaid: Number(await f.loan.installmentsPaid()),
        installmentsDue: Number(await f.loan.installmentsDueCount()),
        delinquentSince: Number(await f.loan.delinquentSince()),
        principalOutstanding: (await f.loan.principalOutstanding()).toString(),
        interestAccrued: (await f.loan.interestAccrued()).toString(),
        lateFeeAccrued: (await f.loan.lateFeeAccrued()).toString(),
      });
    };

    await pushState("activated");

    await time.increase(9 * DAY);
    await f.loan.accrueInterest();
    const onTimeAmt = (await f.loan.totalDebtWithFees()) / 6n;
    await f.usdc.mint(f.borrower.address, onTimeAmt);
    await f.usdc.connect(f.borrower).approve(loanAddr, onTimeAmt);
    const tx1 = await f.loan.connect(f.borrower).repay(onTimeAmt);
    txHashes.push(tx1.hash);
    await pushState("on_time_paid");

    await time.increase(3 * DAY);
    await f.loan.checkDelinquency();
    const graceAmt = (await f.loan.totalDebtWithFees()) / 7n;
    await f.usdc.mint(f.borrower.address, graceAmt);
    await f.usdc.connect(f.borrower).approve(loanAddr, graceAmt);
    const tx2 = await f.loan.connect(f.borrower).repay(graceAmt);
    txHashes.push(tx2.hash);
    await pushState("within_grace_paid");

    await time.increase(14 * DAY);
    await f.loan.checkDelinquency();
    const partialLate = (await f.loan.totalDebtWithFees()) / 9n;
    await f.usdc.mint(f.borrower.address, partialLate);
    await f.usdc.connect(f.borrower).approve(loanAddr, partialLate);
    const tx3 = await f.loan.connect(f.borrower).repay(partialLate);
    txHashes.push(tx3.hash);
    await pushState("late_partial_paid");

    await time.increase(45 * DAY);
    const tx4 = await f.loan.markDefault();
    txHashes.push(tx4.hash);
    await pushState("defaulted");

    const tx5 = await f.loan.connect(f.lender).claimCollateral();
    txHashes.push(tx5.hash);
    await pushState("collateral_claimed");

    const scheduleHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "uint256"],
        [
          await f.loan.totalInstallments(),
          await f.loan.installmentInterval(),
          await f.loan.installmentGracePeriod(),
          f.principal,
        ],
      ),
    );

    const manifest = {
      suite: "Unified v1.1 — Installment E2E Stress",
      loanId: loanAddr,
      schedule_hash: scheduleHash,
      tx_hashes: txHashes,
      installment_states_over_time: stateSnapshots,
      delinquency_metrics: {
        finalInstallmentsDue: Number(await f.loan.installmentsDueCount()),
        finalInstallmentsPaid: Number(await f.loan.installmentsPaid()),
        finalDelinquentSince: Number(await f.loan.delinquentSince()),
        finalLateFeeAccrued: (await f.loan.lateFeeAccrued()).toString(),
      },
      breaker_events: [],
    };

    // eslint-disable-next-line no-console
    console.log("INSTALLMENT_E2E_MANIFEST", JSON.stringify(manifest, null, 2));

    expect(manifest.loanId).to.equal(loanAddr);
    expect(manifest.tx_hashes.length).to.be.gte(5);
    expect(manifest.installment_states_over_time.length).to.be.gte(5);
  });
});
