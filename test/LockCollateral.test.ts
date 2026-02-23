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

/** Deploy the full protocol stack and create one DIRECT loan. */
async function setup() {
  const [admin, borrower, stranger, lender] = await ethers.getSigners();

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

  // Grant factory LOAN_REGISTRAR_ROLE on vault and feeManager
  await vault.grantRole(
    await vault.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );
  await feeManager.grantRole(
    await feeManager.LOAN_REGISTRAR_ROLE(),
    await factory.getAddress(),
  );

  // Allow the collateral token
  await timelockExec(factory, "allowCollateral", [
    await collateralToken.getAddress(),
  ]);

  const loanParams = {
    fundingModel: 0, // DIRECT
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

  await factory.connect(borrower).createLoan(loanParams);
  const loanAddress = await factory.loans(0);
  const loan = await ethers.getContractAt("UnifiedLoan", loanAddress);

  // Mint collateral to borrower and approve the vault
  await collateralToken.mint(borrower.address, loanParams.collateralAmount);
  await collateralToken
    .connect(borrower)
    .approve(await vault.getAddress(), loanParams.collateralAmount);

  // Mint USDC to lender and approve the loan
  await usdc.mint(lender.address, loanParams.principalAmount);
  await usdc.connect(lender).approve(loanAddress, loanParams.principalAmount);

  return {
    admin,
    borrower,
    stranger,
    lender,
    usdc,
    collateralToken,
    vault,
    loan,
    factory,
    loanParams,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("UnifiedLoan.lockCollateral() wrapper", function () {
  // ── Happy path ──────────────────────────────────────────────────────────

  it("borrower can lock collateral via the loan wrapper (CREATED state)", async function () {
    const { borrower, vault, loan, loanParams } = await setup();

    expect(await loan.status()).to.equal(0); // CREATED
    expect(await loan.collateralLocked()).to.equal(false);

    await expect(loan.connect(borrower).lockCollateral())
      .to.emit(loan, "CollateralLocked")
      .withArgs(
        await loan.getAddress(),
        borrower.address,
        await loan.collateralAsset(),
        loanParams.collateralAmount,
      );

    expect(await loan.collateralLocked()).to.equal(true);

    // Vault must reflect the locked position
    const [token, totalAmt, remainingAmt, isLocked] = await vault.lockedByLoan(
      await loan.getAddress(),
    );

    expect(token).to.equal(await loan.collateralAsset());
    expect(totalAmt).to.equal(loanParams.collateralAmount);
    expect(remainingAmt).to.equal(loanParams.collateralAmount);
    expect(isLocked).to.equal(true);
  });

  it("borrower can lock collateral via the loan wrapper (FUNDING state)", async function () {
    const { borrower, lender, vault, loan, loanParams } = await setup();

    // Fund first so loan is in FUNDING state
    await loan.connect(lender).fund(loanParams.principalAmount / 2n);
    expect(await loan.status()).to.equal(1); // FUNDING

    await expect(loan.connect(borrower).lockCollateral()).to.emit(
      loan,
      "CollateralLocked",
    );

    expect(await loan.collateralLocked()).to.equal(true);
    const [, , , isLocked] = await vault.lockedByLoan(await loan.getAddress());
    expect(isLocked).to.equal(true);
  });

  it("locked collateral enables activateAndDisburse to succeed", async function () {
    const { borrower, lender, loan, loanParams } = await setup();

    // Fund fully
    await loan.connect(lender).fund(loanParams.principalAmount);

    // Lock via wrapper
    await loan.connect(borrower).lockCollateral();

    // Activate — should not revert
    await expect(loan.connect(borrower).activateAndDisburse()).to.emit(
      loan,
      "Activated",
    );

    expect(await loan.status()).to.equal(2); // ACTIVE
  });

  it("vault shows correct token and amounts after wrapper lock", async function () {
    const { borrower, vault, loan, loanParams, collateralToken } =
      await setup();

    await loan.connect(borrower).lockCollateral();

    const [token, totalAmt, remainingAmt, isLocked] = await vault.lockedByLoan(
      await loan.getAddress(),
    );

    expect(token).to.equal(await collateralToken.getAddress());
    expect(totalAmt).to.equal(loanParams.collateralAmount);
    expect(remainingAmt).to.equal(loanParams.collateralAmount);
    expect(isLocked).to.equal(true);
  });

  // ── Access control ──────────────────────────────────────────────────────

  it("reverts NotBorrower when a non-borrower calls lockCollateral", async function () {
    const { stranger, loan } = await setup();

    await expect(
      loan.connect(stranger).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "NotBorrower");
  });

  it("reverts NotBorrower when the lender calls lockCollateral", async function () {
    const { lender, loan } = await setup();

    await expect(
      loan.connect(lender).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "NotBorrower");
  });

  it("reverts NotBorrower when admin calls lockCollateral", async function () {
    const { admin, loan } = await setup();

    await expect(
      loan.connect(admin).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "NotBorrower");
  });

  // ── Double-lock guard ───────────────────────────────────────────────────

  it("reverts AlreadyLocked on a second lockCollateral call", async function () {
    const { borrower, collateralToken, vault, loan, loanParams } =
      await setup();

    // First lock succeeds
    await loan.connect(borrower).lockCollateral();

    // Mint more collateral and re-approve so the vault could accept if the guard fails
    await collateralToken.mint(borrower.address, loanParams.collateralAmount);
    await collateralToken
      .connect(borrower)
      .approve(await vault.getAddress(), loanParams.collateralAmount);

    // Second lock must revert
    await expect(
      loan.connect(borrower).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "AlreadyLocked");
  });

  // ── Invalid status guard ────────────────────────────────────────────────

  it("reverts InvalidStatus when loan is ACTIVE", async function () {
    const { borrower, lender, loan, loanParams } = await setup();

    // Get loan to ACTIVE state
    await loan.connect(lender).fund(loanParams.principalAmount);
    await loan.connect(borrower).lockCollateral();
    await loan.connect(borrower).activateAndDisburse();
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Mint fresh collateral for a potential second lock
    await expect(
      loan.connect(borrower).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "AlreadyLocked");
  });

  it("reverts InvalidStatus when loan is REPAID", async function () {
    const { borrower, lender, usdc, loan, loanParams } = await setup();
    const loanAddr = await loan.getAddress();

    await loan.connect(lender).fund(loanParams.principalAmount);
    await loan.connect(borrower).lockCollateral();
    await loan.connect(borrower).activateAndDisburse();

    const debt = await loan.totalDebt();
    await usdc.mint(borrower.address, debt);
    await usdc.connect(borrower).approve(loanAddr, debt);
    await loan.connect(borrower).repay(debt);
    expect(await loan.status()).to.equal(3); // REPAID

    await expect(
      loan.connect(borrower).lockCollateral(),
    ).to.be.revertedWithCustomError(loan, "AlreadyLocked");
  });

  // ── Direct borrower vault access (optional path B) ───────────────────────

  it("borrower can also lock via the vault directly (path B)", async function () {
    const { borrower, vault, loan, loanParams, collateralToken } =
      await setup();

    const loanAddr = await loan.getAddress();
    const vaultAddr = await vault.getAddress();

    // borrower calls vault.lockCollateral with themselves as fromBorrower
    // vault allows this because loan has LOAN_ROLE
    await expect(
      vault
        .connect(borrower)
        .lockCollateral(
          loanAddr,
          await collateralToken.getAddress(),
          loanParams.collateralAmount,
          borrower.address,
        ),
    )
      .to.emit(vault, "CollateralLocked")
      .withArgs(
        loanAddr,
        await collateralToken.getAddress(),
        borrower.address,
        loanParams.collateralAmount,
      );

    const [, , , isLocked] = await vault.lockedByLoan(loanAddr);
    expect(isLocked).to.equal(true);
  });

  it("vault reverts Unauthorized when a stranger impersonates the borrower as fromBorrower", async function () {
    const { borrower, stranger, vault, loan, loanParams, collateralToken } =
      await setup();

    // stranger calls the vault passing the REAL borrower as fromBorrower.
    // msg.sender (stranger) != fromBorrower (borrower), and stranger has no LOAN_ROLE.
    await expect(
      vault
        .connect(stranger)
        .lockCollateral(
          await loan.getAddress(),
          await collateralToken.getAddress(),
          loanParams.collateralAmount,
          borrower.address,
        ),
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
  });

  it("vault reverts Unauthorized when caller is borrower but loan is not registered", async function () {
    const { borrower, vault, loanParams, collateralToken } = await setup();

    // Use a random fake address as the loan — it won't have LOAN_ROLE
    const fakeAddress = ethers.Wallet.createRandom().address;

    await expect(
      vault
        .connect(borrower)
        .lockCollateral(
          fakeAddress,
          await collateralToken.getAddress(),
          loanParams.collateralAmount,
          borrower.address,
        ),
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
  });
});
