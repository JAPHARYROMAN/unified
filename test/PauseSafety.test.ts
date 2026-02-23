import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

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

async function deployCore() {
  const [admin, borrower, lender, depositor, stranger] =
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

  const PRINCIPAL = 10_000_000n;
  const COLLATERAL = ethers.parseEther("5");

  const directParams = {
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

  return {
    admin,
    borrower,
    lender,
    depositor,
    stranger,
    usdc,
    weth,
    treasury,
    feeManager,
    vault,
    factory,
    directParams,
    PRINCIPAL,
    COLLATERAL,
  };
}

async function createLoan(
  f: Awaited<ReturnType<typeof deployCore>>,
  params: any,
) {
  await f.factory.connect(f.borrower).createLoan(params);
  const idx = (await f.factory.loanCount()) - 1n;
  const addr = await f.factory.loans(idx);
  return ethers.getContractAt("UnifiedLoan", addr);
}

async function fundedLockedDirectLoan(
  f: Awaited<ReturnType<typeof deployCore>>,
) {
  const loan = await createLoan(f, f.directParams);
  const loanAddr = await loan.getAddress();

  await f.usdc.mint(f.lender.address, f.PRINCIPAL);
  await f.usdc.connect(f.lender).approve(loanAddr, f.PRINCIPAL);
  await loan.connect(f.lender).fund(f.PRINCIPAL);

  const loanRole = await f.vault.LOAN_ROLE();
  await f.vault.connect(f.admin).grantRole(loanRole, f.admin.address);
  await f.weth.mint(f.borrower.address, f.COLLATERAL);
  await f.weth
    .connect(f.borrower)
    .approve(await f.vault.getAddress(), f.COLLATERAL);
  await f.vault
    .connect(f.admin)
    .lockCollateral(
      loanAddr,
      await f.weth.getAddress(),
      f.COLLATERAL,
      f.borrower.address,
    );

  return loan;
}

describe("Pause Safety Validation", function () {
  it("blocks new loan originations when factory is paused", async function () {
    const f = await deployCore();
    await f.factory.connect(f.admin).pause();

    await expect(
      f.factory.connect(f.borrower).createLoan(f.directParams),
    ).to.be.revertedWithCustomError(f.factory, "EnforcedPause");
  });

  it("blocks new pool deposits when pool is paused", async function () {
    const f = await deployCore();

    const Pool = await ethers.getContractFactory("UnifiedPool");
    const pool = await Pool.deploy(
      f.admin.address,
      await f.usdc.getAddress(),
      ethers.encodeBytes32String("pause-safe"),
    );

    await f.usdc.mint(f.depositor.address, f.PRINCIPAL);
    await f.usdc
      .connect(f.depositor)
      .approve(await pool.getAddress(), f.PRINCIPAL);

    await pool.connect(f.admin).pause();

    await expect(
      pool.connect(f.depositor).deposit(f.PRINCIPAL),
    ).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("invariant #1: CROWDFUND refund is allowed during pause after deadline", async function () {
    const f = await deployCore();

    const now = await time.latest();
    const deadline = now + 3600;

    const loan = await createLoan(f, {
      ...f.directParams,
      fundingModel: 1,
      fundingDeadline: deadline,
    });
    const loanAddr = await loan.getAddress();

    const partial = f.PRINCIPAL / 2n;
    await f.usdc.mint(f.lender.address, partial);
    await f.usdc.connect(f.lender).approve(loanAddr, partial);
    await loan.connect(f.lender).fund(partial);

    await time.increaseTo(deadline + 1);
    await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);

    const balBefore = await f.usdc.balanceOf(f.lender.address);
    await loan.connect(f.lender).withdrawContribution();
    const balAfter = await f.usdc.balanceOf(f.lender.address);

    expect(balAfter - balBefore).to.equal(partial);
    expect(await loan.fundedAmount()).to.equal(0);
  });

  it("invariant #2: pool withdrawal queue continues during pause", async function () {
    const f = await deployCore();

    const Pool = await ethers.getContractFactory("UnifiedPool");
    const pool = await Pool.deploy(
      f.admin.address,
      await f.usdc.getAddress(),
      ethers.encodeBytes32String("queue-safe"),
    );

    const depositAmt = 20_000_000n;
    await f.usdc.mint(f.depositor.address, depositAmt);
    await f.usdc
      .connect(f.depositor)
      .approve(await pool.getAddress(), depositAmt);
    await pool.connect(f.depositor).deposit(depositAmt);

    const shares = (await pool.positions(f.depositor.address)).shares;
    const half = shares / 2n;

    await pool.connect(f.depositor).requestWithdraw(half);
    await pool.connect(f.admin).pause();

    const balBefore = await f.usdc.balanceOf(f.depositor.address);
    await pool.fulfillWithdraw(0);
    const balAfter = await f.usdc.balanceOf(f.depositor.address);

    expect(balAfter).to.be.gt(balBefore);
    expect(await pool.pendingShares(f.depositor.address)).to.equal(0);
  });

  it("invariant #3: repay is always callable while paused", async function () {
    const f = await deployCore();
    const loan = await fundedLockedDirectLoan(f);
    const loanAddr = await loan.getAddress();

    await loan.connect(f.borrower).activateAndDisburse();
    await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);

    await f.usdc.mint(f.borrower.address, f.PRINCIPAL);
    await f.usdc.connect(f.borrower).approve(loanAddr, f.PRINCIPAL);

    await expect(loan.connect(f.borrower).repay(f.PRINCIPAL)).to.emit(
      loan,
      "Repaid",
    );
  });

  it("invariant #4: default collateral claim is callable while paused", async function () {
    const f = await deployCore();
    const loan = await fundedLockedDirectLoan(f);
    const loanAddr = await loan.getAddress();

    await loan.connect(f.borrower).activateAndDisburse();
    await time.increase(31 * 24 * 3600 + 7 * 24 * 3600 + 1);
    await loan.markDefault();

    await f.factory.connect(f.admin).setLoanPaused(loanAddr, true);

    await expect(loan.connect(f.lender).claimCollateral()).to.emit(
      loan,
      "CollateralClaimed",
    );
  });
});
