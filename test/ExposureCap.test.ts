import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/* ═══════════════════════════════════════════════════════════════════════════
 *  On-chain Borrower Exposure Cap — Unified v1.1
 *
 *  Validates the non-bypassable hard guardrail that prevents a single borrower
 *  from exceeding a configured total outstanding principal across all loans.
 *
 *  Coverage:
 *    1. Setter governance (timelocked, admin-only, event emission)
 *    2. Cap enforcement in createLoan
 *    3. Cap disabled (0 = no cap)
 *    4. Cap respects terminal loan states (REPAID / CLOSED / DEFAULTED)
 *    5. No bypass via partner context or alternate creation path
 *    6. Multiple borrowers are independent
 *    7. borrowerOutstanding view accuracy
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

// ── Fixture ─────────────────────────────────────────────────────────────

async function exposureCapFixture() {
  const [admin, borrowerA, borrowerB, lender] = await ethers.getSigners();

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

  /**
   * Helper: build loan params for a borrower with given principal.
   */
  function loanParams(borrower: string, principalAmount: bigint) {
    return {
      fundingModel: 0,
      repaymentModel: 0,
      borrower,
      collateralToken: weth.target as string,
      collateralAmount: ethers.parseEther("5"),
      principalAmount,
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
  }

  /**
   * Helper: create a loan, fund it, lock collateral, and optionally activate it.
   * Returns the loan contract instance.
   */
  async function createAndPrepareLoan(
    borrowerSigner: any,
    principalAmount: bigint,
    opts?: { activate?: boolean },
  ) {
    const params = loanParams(borrowerSigner.address, principalAmount);
    await factory.connect(borrowerSigner).createLoan(params);
    const idx = (await factory.loanCount()) - 1n;
    const loanAddr = await factory.loans(idx);
    const loan = await ethers.getContractAt("UnifiedLoan", loanAddr);

    // Fund
    await usdc.mint(lender.address, principalAmount);
    await usdc.connect(lender).approve(loanAddr, principalAmount);
    await loan.connect(lender).fund(principalAmount);

    // Lock collateral
    const loanRole = await vault.LOAN_ROLE();
    await vault.connect(admin).grantRole(loanRole, admin.address);
    await weth.mint(borrowerSigner.address, params.collateralAmount);
    await weth
      .connect(borrowerSigner)
      .approve(await vault.getAddress(), params.collateralAmount);
    await vault
      .connect(admin)
      .lockCollateral(
        loanAddr,
        await weth.getAddress(),
        params.collateralAmount,
        borrowerSigner.address,
      );

    if (opts?.activate) {
      await loan.connect(borrowerSigner).activateAndDisburse();
    }

    return loan;
  }

  return {
    admin,
    borrowerA,
    borrowerB,
    lender,
    usdc,
    weth,
    vault,
    factory,
    feeManager,
    loanParams,
    createAndPrepareLoan,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  1. Governance: setMaxBorrowerExposure
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: governance setter", function () {
  it("setMaxBorrowerExposure is timelocked and emits MaxBorrowerExposureUpdated", async function () {
    const { factory } = await exposureCapFixture();
    const cap = 50_000_000n; // 50 USDC

    // Schedule timelock
    const id = computeTimelockId(factory.interface, "setMaxBorrowerExposure", [
      cap,
    ]);
    await factory.scheduleTimelock(id);
    await time.increase(TIMELOCK_DELAY);

    // Execute and verify event
    await expect(factory.setMaxBorrowerExposure(cap))
      .to.emit(factory, "MaxBorrowerExposureUpdated")
      .withArgs(0, cap);

    expect(await factory.maxBorrowerExposure()).to.equal(cap);
  });

  it("reverts without timelock", async function () {
    const { factory } = await exposureCapFixture();

    await expect(
      factory.setMaxBorrowerExposure(50_000_000n),
    ).to.be.revertedWithCustomError(factory, "TimelockNotScheduled");
  });

  it("reverts when caller is not admin", async function () {
    const { factory, borrowerA } = await exposureCapFixture();

    await expect(factory.connect(borrowerA).setMaxBorrowerExposure(50_000_000n))
      .to.be.reverted;
  });

  it("can be set to 0 (disabled)", async function () {
    const { factory } = await exposureCapFixture();

    // Set a cap first
    await timelockExec(factory, "setMaxBorrowerExposure", [50_000_000n]);
    expect(await factory.maxBorrowerExposure()).to.equal(50_000_000n);

    // Disable it
    await timelockExec(factory, "setMaxBorrowerExposure", [0]);
    expect(await factory.maxBorrowerExposure()).to.equal(0n);
  });

  it("can update cap value (timelocked)", async function () {
    const { factory } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [50_000_000n]);

    // Schedule + wait for the second update
    const id = computeTimelockId(factory.interface, "setMaxBorrowerExposure", [
      100_000_000n,
    ]);
    await factory.scheduleTimelock(id);
    await time.increase(TIMELOCK_DELAY);

    await expect(factory.setMaxBorrowerExposure(100_000_000n))
      .to.emit(factory, "MaxBorrowerExposureUpdated")
      .withArgs(50_000_000n, 100_000_000n);

    expect(await factory.maxBorrowerExposure()).to.equal(100_000_000n);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  2. Cap disabled by default
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: disabled by default", function () {
  it("maxBorrowerExposure defaults to 0 (no cap)", async function () {
    const { factory } = await exposureCapFixture();
    expect(await factory.maxBorrowerExposure()).to.equal(0n);
  });

  it("allows unlimited loans when cap is 0", async function () {
    const { factory, borrowerA, lender, usdc, weth, vault, admin, loanParams } =
      await exposureCapFixture();

    // Create 3 loans for same borrower — should all succeed with no cap
    for (let i = 0; i < 3; i++) {
      await factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n));
    }

    expect(await factory.borrowerLoanCount(borrowerA.address)).to.equal(3);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  3. Cap enforcement in createLoan
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: enforcement", function () {
  it("allows first loan within cap", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [20_000_000n]);

    // 10M ≤ 20M cap → ok
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).not.to.be.reverted;
  });

  it("allows loan at exact cap boundary", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // 10M == 10M cap → ok
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).not.to.be.reverted;
  });

  it("rejects loan that exceeds cap", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // 15M > 10M cap → revert
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 15_000_000n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");
  });

  it("rejects second loan that would push borrower over cap", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [15_000_000n]);

    // First loan: 10M (total = 10M ≤ 15M) → ok
    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));

    // Second loan: 10M (total would be 20M > 15M) → revert
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");
  });

  it("allows second loan when combined exposure is within cap", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [25_000_000n]);

    // First: 10M
    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));

    // Second: 10M (total = 20M ≤ 25M) → ok
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).not.to.be.reverted;
  });

  it("rejects via createLoanDeterministic as well (no bypass)", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [5_000_000n]);

    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt-1"));

    await expect(
      factory
        .connect(borrowerA)
        .createLoanDeterministic(
          loanParams(borrowerA.address, 10_000_000n),
          salt,
        ),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  4. Cap respects terminal loan states
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: terminal state exclusion", function () {
  it("closed loan frees up exposure for new loans", async function () {
    const { factory, borrowerA, loanParams, createAndPrepareLoan, usdc } =
      await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // Create & activate loan
    const loan = await createAndPrepareLoan(borrowerA, 10_000_000n, {
      activate: true,
    });
    expect(await loan.status()).to.equal(2); // ACTIVE

    // Cannot create another — at cap
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 5_000_000n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");

    // Repay and close the loan
    const debt = await loan.totalDebt();
    await usdc.mint(borrowerA.address, debt);
    await usdc.connect(borrowerA).approve(await loan.getAddress(), debt);
    await loan.connect(borrowerA).repay(debt);
    await loan.close();
    expect(await loan.status()).to.equal(5); // CLOSED

    // Now borrower can create a new loan — outstanding is 0
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).not.to.be.reverted;
  });

  it("defaulted loan frees up exposure for new loans", async function () {
    const { factory, borrowerA, loanParams, createAndPrepareLoan } =
      await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // Create & activate
    const loan = await createAndPrepareLoan(borrowerA, 10_000_000n, {
      activate: true,
    });

    // Fast-forward past maturity + grace period
    const duration = 30 * 24 * 3600;
    const grace = 7 * 24 * 3600;
    await time.increase(duration + grace + 1);

    await loan.markDefault();
    expect(await loan.status()).to.equal(4); // DEFAULTED

    // Borrower can create a new loan
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).not.to.be.reverted;
  });

  it("repaid loan frees up exposure", async function () {
    const { factory, borrowerA, loanParams, createAndPrepareLoan, usdc } =
      await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // Create & activate
    const loan = await createAndPrepareLoan(borrowerA, 10_000_000n, {
      activate: true,
    });

    // Repay the full debt
    const debt = await loan.totalDebt();
    await usdc.mint(borrowerA.address, debt);
    await usdc.connect(borrowerA).approve(await loan.getAddress(), debt);
    await loan.connect(borrowerA).repay(debt);
    expect(await loan.status()).to.equal(3); // REPAID

    // Exposure freed — can create again
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 10_000_000n)),
    ).not.to.be.reverted;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  5. Multiple borrowers are independent
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: borrower independence", function () {
  it("borrowers have independent exposure tracking", async function () {
    const { factory, borrowerA, borrowerB, loanParams } =
      await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // Borrower A: 10M → ok (at cap)
    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));

    // Borrower B: 10M → also ok (separate tracking)
    await expect(
      factory
        .connect(borrowerB)
        .createLoan(loanParams(borrowerB.address, 10_000_000n)),
    ).not.to.be.reverted;

    // Borrower A: 1M more → rejected
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 1_000_000n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  6. borrowerOutstanding view
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: borrowerOutstanding view", function () {
  it("returns 0 for new borrower", async function () {
    const { factory, borrowerA } = await exposureCapFixture();
    expect(await factory.borrowerOutstanding(borrowerA.address)).to.equal(0n);
  });

  it("accumulates across CREATED loans", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));
    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 5_000_000n));

    expect(await factory.borrowerOutstanding(borrowerA.address)).to.equal(
      15_000_000n,
    );
  });

  it("includes ACTIVE loans", async function () {
    const { factory, borrowerA, createAndPrepareLoan } =
      await exposureCapFixture();

    await createAndPrepareLoan(borrowerA, 10_000_000n, { activate: true });
    expect(await factory.borrowerOutstanding(borrowerA.address)).to.equal(
      10_000_000n,
    );
  });

  it("excludes REPAID loans", async function () {
    const { factory, borrowerA, loanParams, createAndPrepareLoan, usdc } =
      await exposureCapFixture();

    const loan = await createAndPrepareLoan(borrowerA, 10_000_000n, {
      activate: true,
    });
    const debt = await loan.totalDebt();
    await usdc.mint(borrowerA.address, debt);
    await usdc.connect(borrowerA).approve(await loan.getAddress(), debt);
    await loan.connect(borrowerA).repay(debt);
    expect(await loan.status()).to.equal(3); // REPAID

    expect(await factory.borrowerOutstanding(borrowerA.address)).to.equal(0n);
  });

  it("excludes CLOSED loans", async function () {
    const { factory, borrowerA, loanParams, createAndPrepareLoan, usdc } =
      await exposureCapFixture();

    const loan = await createAndPrepareLoan(borrowerA, 10_000_000n, {
      activate: true,
    });
    const debt = await loan.totalDebt();
    await usdc.mint(borrowerA.address, debt);
    await usdc.connect(borrowerA).approve(await loan.getAddress(), debt);
    await loan.connect(borrowerA).repay(debt);
    await loan.close();
    expect(await loan.status()).to.equal(5); // CLOSED

    expect(await factory.borrowerOutstanding(borrowerA.address)).to.equal(0n);
  });

  it("excludes DEFAULTED loans", async function () {
    const { factory, borrowerA, createAndPrepareLoan } =
      await exposureCapFixture();

    const loan = await createAndPrepareLoan(borrowerA, 10_000_000n, {
      activate: true,
    });
    const duration = 30 * 24 * 3600;
    const grace = 7 * 24 * 3600;
    await time.increase(duration + grace + 1);
    await loan.markDefault();
    expect(await loan.status()).to.equal(4); // DEFAULTED

    expect(await factory.borrowerOutstanding(borrowerA.address)).to.equal(0n);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  7. Cap change after existing loans
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("Exposure Cap: dynamic cap adjustment", function () {
  it("lowering cap blocks new loans that exceed it", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    // No cap — create first loan
    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));

    // Set cap to 10M — now at the limit
    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    // Any new loan is blocked
    await expect(
      factory.connect(borrowerA).createLoan(loanParams(borrowerA.address, 1n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");
  });

  it("raising cap allows previously blocked loans", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));

    // Blocked at 10M cap
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 5_000_000n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");

    // Raise cap
    await timelockExec(factory, "setMaxBorrowerExposure", [20_000_000n]);

    // Now allowed
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 5_000_000n)),
    ).not.to.be.reverted;
  });

  it("disabling cap unblocks all borrowers", async function () {
    const { factory, borrowerA, loanParams } = await exposureCapFixture();

    await timelockExec(factory, "setMaxBorrowerExposure", [10_000_000n]);

    await factory
      .connect(borrowerA)
      .createLoan(loanParams(borrowerA.address, 10_000_000n));

    // Blocked
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 1_000_000n)),
    ).to.be.revertedWithCustomError(factory, "BorrowerExposureCapExceeded");

    // Disable
    await timelockExec(factory, "setMaxBorrowerExposure", [0]);

    // Unlimited
    await expect(
      factory
        .connect(borrowerA)
        .createLoan(loanParams(borrowerA.address, 100_000_000n)),
    ).not.to.be.reverted;
  });
});
