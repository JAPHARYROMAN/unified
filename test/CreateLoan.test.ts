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

async function deployFixture() {
  const [admin, borrower] = await ethers.getSigners();

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

  return { admin, borrower, usdc, collateralToken, factory };
}

describe("Unified create loan", function () {
  it("creates a loan clone and initializes it", async function () {
    const { admin, borrower, collateralToken, factory } = await deployFixture();

    await timelockExec(factory, "allowCollateral", [
      await collateralToken.getAddress(),
    ]);

    const params = {
      fundingModel: 1,
      repaymentModel: 0,
      borrower: borrower.address,
      collateralToken: await collateralToken.getAddress(),
      collateralAmount: ethers.parseEther("2"),
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

    expect(await factory.loanCount()).to.equal(1);
    const loanAddress = await factory.loans(0);
    expect(await factory.isLoan(loanAddress)).to.equal(true);

    const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);
    expect(await loan.status()).to.equal(0);
  });

  it("reverts if collateral token is not allowed", async function () {
    const { borrower, collateralToken, factory } = await deployFixture();

    const params = {
      fundingModel: 0,
      repaymentModel: 0,
      borrower: borrower.address,
      collateralToken: await collateralToken.getAddress(),
      collateralAmount: ethers.parseEther("1"),
      principalAmount: 1_000_000n,
      interestRateBps: 800,
      durationSeconds: 14 * 24 * 3600,
      gracePeriodSeconds: 3 * 24 * 3600,
      fundingDeadline: 0,
      pool: ethers.ZeroAddress,
      totalInstallments: 0,
      installmentInterval: 0,
      installmentGracePeriod: 0,
      penaltyAprBps: 0,
      defaultThresholdDays: 0,
      scheduleHash: ethers.ZeroHash,
    };

    await expect(
      factory.connect(borrower).createLoan(params),
    ).to.be.revertedWithCustomError(factory, "CollateralNotAllowed");
  });
});
