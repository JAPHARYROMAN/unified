import { expect } from "chai";
import { ethers } from "hardhat";

describe("Unified deployment", function () {
  it("deploys and wires core contracts", async function () {
    const [admin] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

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

    expect(await factory.usdc()).to.equal(await usdc.getAddress());
    expect(await factory.collateralVault()).to.equal(await vault.getAddress());
    expect(await factory.feeManager()).to.equal(await feeManager.getAddress());
    expect(await factory.treasury()).to.equal(await treasury.getAddress());
    expect(await factory.loanCount()).to.equal(0);

    expect(
      await vault.hasRole(registrarRole, await factory.getAddress()),
    ).to.equal(true);
  });
});
