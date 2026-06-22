import type { Request, Response } from 'express';
import { success, z } from 'zod';
import { TransferFundsUseCase } from '../../domain/use-cases/transfer-funds.use-case.js';

const TransferPayloadSchema = z.object({
    tenantId: z.uuid(),
    senderAccountId: z.uuid(),
    receiverAccountId: z.uuid(),
    amount: z.number().positive("Transfer amount must be greater than zero")
    .multipleOf(0.01, { message: "Invalid Precision: Amount cannot exceed 2 decimal places (Kobo)." }),
    currency: z.string().min(3).max(5),
    reference: z.string().min(5, "Unique reference string required for idempotency protection"),
    description: z.string().max(255).default("Wallet Transfer")
});

export class LedgerController {
    constructor(private readonly transferFundsUseCase: TransferFundsUseCase) {} 

    public handleTransfer = async (req: Request, res: Response): Promise<void> => {
        try {
            const command = TransferPayloadSchema.parse(req.body);

            await this.transferFundsUseCase.execute(command);

            res.status(201).json({
                success: true,
                message: "Transaction processed successfully and balanced lines committed.",
                reference: command.reference
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                res.status(400).json({ success: false, errors: error.issues });
                return;
            }

            if (error.message.includes('Idempotency conflict triggered')) {
                res.status(200).json({
                    success: true,
                    message: "Duplicate request handled safely. Transaction was already executed.",
                    reference: req.body.reference
                });
                return;
            }

            res.status(422).json({
                success: false,
                error: error.message || "Internal transaction subsystem exception."
            });
        }
    };
}