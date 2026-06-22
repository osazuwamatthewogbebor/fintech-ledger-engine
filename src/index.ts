import express from 'express';
import { PostgresLedgerRepository } from './modules/ledger/adapters/repositories/postgres-ledger.repository.js';
import { TransferFundsUseCase } from './modules/ledger/domain/use-cases/transfer-funds.use-case.js';
import { LedgerController } from './modules/ledger/adapters/controllers/ledger.controller.js';

const app = express();
app.use(express.json());

// Inject Dependencies via Hexagonal Pipeline composition
const ledgerRepository = new PostgresLedgerRepository();
const transferUseCase = new TransferFundsUseCase(ledgerRepository);
const ledgerController = new LedgerController(transferUseCase);

// API Endpoint Matrix
app.post('/api/v1/ledger/transfer', ledgerController.handleTransfer);

// Diagnostic Health Verification Endpoint
app.get('/api/v1/ledger/balance/:accountId', async (req, res) => {
    try {
        const accountDetails = (await ledgerRepository.getAccountDetails(req.params.accountId))
        const balanceMoney = accountDetails.balance;
        res.json({
            accountId: req.params.accountId,
            currency: balanceMoney.currency,
            balanceDecimal: Number(balanceMoney.minorUnits) / 100
        });
    } catch (err: any) {
        res.status(404).json({error: err.message});
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Double-Entry Fintech Ledger Core active and listening on port ${PORT}`);
});
