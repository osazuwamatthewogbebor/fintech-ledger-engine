import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransferFundsUseCase, type TranserFundsCommand } from '../domain/use-cases/transfer-funds.use-case.js';
import { Money } from '../domain/value-objects/money.vo.js';
import type { ILedgerRepository, AccountDetails } from '../ports/ledger-repository.port.js';

describe("TranseferFundsUseCase (Unit Tests", () => {
    let mockRepository: ILedgerRepository;
    let useCase: TransferFundsUseCase;

    beforeEach(() => {
        mockRepository = {
            getAccountDetails: vi.fn(),
            saveTransaction: vi.fn(),
        };
        useCase = new TransferFundsUseCase(mockRepository)
    });

    it("should successfully execute a balanced transfer between standard accounts with sufficient capital", async () => {
        const command: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "sender-account-uuid",
            receiverAccountId: "receiver-account-uuid",
            amount: 1500,
            currency: "NGN",
            reference: "TX_REF_001",
            description: "Peer to peer test transfer"
        };

        // Mock Sender: Has 5,000 NGN
        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_matthew_wallet",
            balance: Money.fromDecimal(5000.00, "NGN")
        });

        // Mock Receiver: Has 0 NGN
        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_blessing_wallet",
            balance: Money.fromDecimal(0.00, "NGN")
        });

        await expect(useCase.execute(command)).resolves.not.toThrow();

        expect(mockRepository.saveTransaction).toHaveBeenCalledTimes(1);
    })

    it("should reject transactions if the sender has insufficient capital", async () => {
        const command: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "sender-account-uuid",
            receiverAccountId: "receiver-account-uuid",
            amount: 10000.00, // Demanding more than available
            currency: "NGN",
            reference: "TX_REF_002",
            description: "Overdraft attempt"
        };

        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_matthew_wallet",
            balance: Money.fromDecimal(2000.00, "NGN")
        });

        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_blessing_wallet",
            balance: Money.fromDecimal(0.00, "NGN")
        });

        await expect(useCase.execute(command)).rejects.toThrowError(
            /Transaction Denied: Insufficient capital/
        );
    });

    it("should allow permissive system accounts to bypass liquidity checks and hold a negative balance", async () => {
        const command: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "PAYSTACK_CLEARING_CHANNEL", // Explicitly a permissive agent ID
            receiverAccountId: "receiver-account-uuid",
            amount: 2500.00,
            currency: "NGN",
            reference: "TX_REF_003",
            description: "System deposit bypass test"
        };

        // The system clearing channel starts at 0 NGN
        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "PAYSTACK_CLEARING_CHANNEL",
            balance: Money.fromDecimal(0.00, "NGN")
        });

        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_matthew_wallet",
            balance: Money.fromDecimal(0.00, "NGN")
        });

        // This would fail for standard consumers, but should pass for our permissive clearing channel
        await expect(useCase.execute(command)).resolves.not.toThrow();
        expect(mockRepository.saveTransaction).toHaveBeenCalledTimes(1);
    });

    it("should instantly block transactions if sender and receiver IDs are identical", async () => {
        const command: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "same-account-uuid",
            receiverAccountId: "same-account-uuid",
            amount: 500.00,
            currency: "NGN",
            reference: "TX_REF_004",
            description: "Self transfer exploit loop"
        };

        await expect(useCase.execute(command)).rejects.toThrowError(
            /Sender and receiver accounts must be distinct/
        );
    });

   
    it("should block malicious hackers attempting to pass negative amounts or zero value", async () => {
        const maliciousCommand: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "sender-account-uuid",
            receiverAccountId: "receiver-account-uuid",
            amount: -5000.00, // 🥷 Negative money injection exploit attempt
            currency: "NGN",
            reference: "HACK_TX_001",
            description: "Exploit attempt"
        };

        await expect(useCase.execute(maliciousCommand)).rejects.toThrowError(
            /Line entries must represent positive financial values/
        );
        expect(mockRepository.saveTransaction).not.toHaveBeenCalled();
    });

    it("should instantly abort if the sender and receiver accounts use mismatched currencies", async () => {
        const command: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "sender-account-ngn",
            receiverAccountId: "receiver-account-usd", // 🛑 Currency mismatch!
            amount: 100.00,
            currency: "NGN",
            reference: "TX_CURR_MISMATCH",
            description: "Cross-currency error validation"
        };

        // Sender has NGN
        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_matthew_wallet",
            balance: Money.fromDecimal(1000.00, "NGN")
        });

        // Receiver has USD
        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_foreign_wallet",
            balance: Money.fromDecimal(0.00, "USD")
        });

        // The Transaction aggregate's internal validation will throw an error when building asymmetric legs
        await expect(useCase.execute(command)).rejects.toThrow();
        expect(mockRepository.saveTransaction).not.toHaveBeenCalled();
    });

    it("should safely handle and enforce fractional penny/kobo limits via the Money Value Object", async () => {
        const command: TranserFundsCommand = {
            tenantId: "tenant-uuid",
            senderAccountId: "sender-account-uuid",
            receiverAccountId: "receiver-account-uuid",
            amount: 0.001, // 🛑 Sub-kobo value that cannot be represented cleanly in minor units
            currency: "NGN",
            reference: "TX_FRACTIONAL_EXPLOIT",
            description: "Testing micro-rounding precision defense"
        };

        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_matthew_wallet",
            balance: Money.fromDecimal(10.00, "NGN")
        });

        vi.mocked(mockRepository.getAccountDetails).mockResolvedValueOnce({
            userId: "user_blessing_wallet",
            balance: Money.fromDecimal(0.00, "NGN")
        });

        // Your Money value object should reject or safely floor fractions to prevent decimal leakage
        await expect(useCase.execute(command)).rejects.toThrow();
    });

})