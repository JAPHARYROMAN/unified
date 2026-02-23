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

async function setup() {
  const [admin, borrower, lender] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  const collateralToken = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

  const Treasury = await ethers.getContractFactory("UnifiedTreasury");
  const treasury = await Treasury.deploy(admin.address);

  const FeeManager = await ethers.getContractFactory("UnifiedFeeManager");
  const feeManager = await FeeManager.deploy(
    admin.address,
    await treasury.getAddress(),
  );
  await timelockExec(feeManager, "setFees", [0, 0, 0]);

  const RiskRegistry = await ethers.getContractFactory("UnifiedRiskRegistry");
  const riskRegistry = await RiskRegistry.deploy(admin.address);

  const Vault = await ethers.getContractFactory("UnifiedCollateralVault");
  const vault = await Vault.deploy(admin.address);

  const Loan = await ethers.getContractFactory("UnifiedLoan");
  const loanImplementation = await Loan.deploy();

  const Factory = await ethers.getContractFactory("UnifiedLoanFactory");
  const factory = await Factory.deploy(
    admin.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await feeManager.getAddress(),
    await treasury.getAddress(),
    await loanImplementation.getAddress(),
  );

  const registrarRole = await vault.LOAN_REGISTRAR_ROLE();
  await vault.grantRole(registrarRole, await factory.getAddress());

  // Wire factory as loan registrar on feeManager
  const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
  await feeManager.grantRole(feeRegistrarRole, await factory.getAddress());

  await timelockExec(factory, "allowCollateral", [
    await collateralToken.getAddress(),
  ]);

  const params = {
    fundingModel: 0,
    repaymentModel: 0,
    borrower: borrower.address,
    collateralToken: await collateralToken.getAddress(),
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
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  // Mint USDC to the lender and approve the loan
  await usdc.mint(lender.address, params.principalAmount);
  await usdc.connect(lender).approve(loanAddress, params.principalAmount);

  // Mint collateral to borrower and approve the vault
  await collateralToken.mint(borrower.address, params.collateralAmount);
  await collateralToken
    .connect(borrower)
    .approve(await vault.getAddress(), params.collateralAmount);

  return {
    admin,
    borrower,
    lender,
    usdc,
    collateralToken,
    vault,
    loan,
    params,
  };
}

describe("Unified loan lifecycle", function () {
  it("funds, locks collateral, activates, repays and closes", async function () {
    const { borrower, lender, usdc, loan, params } = await setup();
    const loanAddr = await loan.getAddress();

    // Lender funds the full principal
    await loan.connect(lender).fund(params.principalAmount);
    expect(await loan.status()).to.equal(1); // FUNDING

    // Borrower locks collateral via the loan wrapper
    await loan.connect(borrower).lockCollateral();

    // Activate and disburse
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Repay the full debt (principal + any accrued interest)
    const debt = await loan.totalDebt();
    await usdc.mint(borrower.address, debt);
    await usdc.connect(borrower).approve(loanAddr, debt);
    await loan.connect(borrower).repay(debt);

    expect(await loan.status()).to.equal(3); // REPAID

    // Close — releases collateral and distributes funds
    await loan.close();
    expect(await loan.status()).to.equal(5); // CLOSED
  });

  it("allows collateral claim after default", async function () {
    const { borrower, lender, loan, params } = await setup();

    // Fund
    await loan.connect(lender).fund(params.principalAmount);

    // Borrower locks collateral via the loan wrapper
    await loan.connect(borrower).lockCollateral();

    // Activate
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Fast-forward past maturity + grace
    await time.increase(params.durationSeconds + params.gracePeriodSeconds + 1);

    // Mark default
    await loan.markDefault();
    expect(await loan.status()).to.equal(4); // DEFAULTED

    // Lender claims collateral
    await loan.connect(lender).claimCollateral();

    // After DIRECT claim, loan auto-closes
    expect(await loan.status()).to.equal(5); // CLOSED
  });
});
