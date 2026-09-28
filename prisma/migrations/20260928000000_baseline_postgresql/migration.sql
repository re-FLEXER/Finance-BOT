CREATE TABLE "Transaction" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "workspace" TEXT NOT NULL DEFAULT 'Особисте',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monoId" TEXT,
    "source" TEXT DEFAULT 'card',
    "toSource" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "batchId" TEXT,
    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatHistory" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportQueue" (
    "id" SERIAL NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportQueue_pkey" PRIMARY KEY ("id")
);