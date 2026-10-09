ALTER TABLE "Transaction"
ALTER COLUMN "amount" TYPE DECIMAL(20, 2)
USING ROUND("amount"::numeric, 2);
