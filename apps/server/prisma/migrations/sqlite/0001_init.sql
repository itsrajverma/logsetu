-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "environment" TEXT NOT NULL DEFAULT 'production',
    "meta" JSONB,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LogEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_apiKey_key" ON "Project"("apiKey");

-- CreateIndex
CREATE INDEX "LogEntry_projectId_timestamp_idx" ON "LogEntry"("projectId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "LogEntry_projectId_level_timestamp_idx" ON "LogEntry"("projectId", "level", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "LogEntry_projectId_source_idx" ON "LogEntry"("projectId", "source");

-- CreateIndex
CREATE INDEX "LogEntry_projectId_environment_idx" ON "LogEntry"("projectId", "environment");

