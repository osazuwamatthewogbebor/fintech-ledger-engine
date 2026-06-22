export class Money {
    private constructor(
        public readonly minorUnits: bigint,
        public readonly currency: string
    ) {}

    // Factory method: converts decimal inputs (1500.50) to safe internal integers (150050n)
    public static fromDecimal(amount: number, currency: string): Money {
        if (amount < 0) {
            throw new Error ("Financial invariant broken: Base allocation amount cannot be negative.")
        }
        const minor = BigInt(Math.round(amount * 100));
        return new Money(minor, currency.toUpperCase());
    }

    public static fromMinor(minorUnits: bigint, currency: string): Money {
        if (minorUnits < 0n) {
            throw new Error("Financial invariant broken: Minor units allocation cannot be negative.")
        }
        return new Money(minorUnits, currency.toUpperCase())
    }

    public add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.minorUnits + other.minorUnits, this.currency)
    }

    public subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.minorUnits - other.minorUnits, this.currency);
    }

    public isGreaterThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.minorUnits > other.minorUnits
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new Error(`Cross-currency operations blocked: ${this.currency} cannot interact with ${other.currency}`)
        }
    }
}