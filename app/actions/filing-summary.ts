"use server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRequiredTaxDocumentTypesForCurrentFlow } from "@/lib/tax/document-requirements";
import { sumMoney, toMoneyNumberOrNull } from "@/lib/money";

async function getOwnedDraft(draftId: string) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;

  if (!email) throw new Error("Unauthorized");

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) throw new Error("User profile not found");

  const draft = await prisma.filingDraft.findFirst({
    where: { id: draftId, userId: user.id },
    select: { id: true, userId: true, incomeSources: true },
  });

  if (!draft) throw new Error("Filing draft not found");

  return draft;
}

export async function getFilingSummaryAction(draftId: string) {
  try {
    const draft = await getOwnedDraft(draftId);
    const [entries, documents, currentDraft, calculationLines] =
      await Promise.all([
      prisma.ledgerEntry.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        select: {
          entryType: true,
          amount: true,
        },
      }),
      prisma.document.findMany({
        where: {
          filingDraftId: draft.id,
          userId: draft.userId,
        },
        orderBy: { createdAt: "desc" },
        select: {
          documentType: true,
          bankAccountId: true,
          extractionStatus: true,
        },
      }),
      prisma.filingDraft.findUnique({
        where: { id: draft.id },
        select: {
          reconciliationStatus: true,
          reconciliationGap: true,
          taxableIncome: true,
          taxWithheld: true,
          taxPayable: true,
          refundDue: true,
          taxCalculationStatus: true,
          taxpayerListStatus: true,
        },
      }),
      // Per-source breakdown from the most recent calculation, so the wizard
      // can show which income produced which part of the liability.
      prisma.filingTaxCalculationLine.findMany({
        where: { filingDraftId: draft.id, userId: draft.userId },
        orderBy: { createdAt: "asc" },
        select: {
          source: true,
          section: true,
          ruleId: true,
          taxBase: true,
          baseTax: true,
          surcharge: true,
          calculatedTax: true,
          detailsJson: true,
        },
      }),
    ]);

    // Decimal columns arrive as Prisma Decimal instances; the wizard needs
    // plain numbers.
    const taxBreakdown = calculationLines.map((line) => {
      let details: { rateShape?: string; isFinalTax?: boolean } = {};
      try {
        details = JSON.parse(line.detailsJson);
      } catch {
        details = {};
      }

      return {
        source: line.source,
        section: line.section,
        ruleId: line.ruleId,
        income: Number(line.taxBase),
        baseTax: Number(line.baseTax),
        surcharge: Number(line.surcharge),
        taxDue: Number(line.calculatedTax),
        isFinalTax: details.isFinalTax === true,
        rateShape: details.rateShape ?? "PROGRESSIVE",
      };
    });

    const finalTaxDue = taxBreakdown
      .filter((line) => line.isFinalTax)
      .reduce((total, line) => total + line.taxDue, 0);
    const assessableTaxDue = taxBreakdown
      .filter((line) => !line.isFinalTax)
      .reduce((total, line) => total + line.taxDue, 0);

    let incomeSources: string[] = [];
    try {
      const parsed = JSON.parse(draft.incomeSources);
      incomeSources = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      incomeSources = [];
    }

    const requiredDocumentTypes = new Set(
      getRequiredTaxDocumentTypesForCurrentFlow({
        incomeSources: incomeSources as any,
      }),
    );
    const hasAccountLinkedBankStatement = documents.some(
      (document) =>
        document.documentType === "bank_statement" &&
        Boolean(document.bankAccountId),
    );
    const latestRequiredDocuments = Array.from(
      new Map<string, (typeof documents)[number]>(
        documents
          .filter((document) =>
            requiredDocumentTypes.has(document.documentType),
          )
          .filter(
            (document) =>
              !hasAccountLinkedBankStatement ||
              document.documentType !== "bank_statement" ||
              Boolean(document.bankAccountId),
          )
          .map((document) => [
            `${document.documentType}:${document.bankAccountId ?? ""}`,
            document,
          ]),
      ).values(),
    );

    // `result.x += entry.amount` is the compound form of the same hazard as
    // `total + entry.amount`: on a Decimal column it appends digits to a
    // string instead of adding, and it is not visible to the type checker.
    const totalFor = (entryType: string) =>
      sumMoney(
        entries
          .filter((entry) => entry.entryType === entryType)
          .map((entry) => entry.amount),
      );

    const totals = {
      income: totalFor("INCOME"),
      expenses: totalFor("EXPENSE"),
      assets: totalFor("ASSET"),
      liabilities: totalFor("LIABILITY"),
    };

    return {
      success: true,
      summary: {
        ...totals,
        ledgerEntryCount: entries.length,
        documentCount: latestRequiredDocuments.length,
        pendingDocumentCount: latestRequiredDocuments.filter(
          (document) => document.extractionStatus === "PENDING",
        ).length,
        reconciliationStatus:
          currentDraft?.reconciliationStatus ?? "UNRESOLVED",
        // These are Decimal columns. The filing wizard compares them against
        // preview numbers and formats them for display, so they are converted
        // here, at the one point where they leave the server.
        reconciliationGap: toMoneyNumberOrNull(currentDraft?.reconciliationGap),
        taxableIncome: toMoneyNumberOrNull(currentDraft?.taxableIncome),
        taxWithheld: toMoneyNumberOrNull(currentDraft?.taxWithheld),
        taxPayable: toMoneyNumberOrNull(currentDraft?.taxPayable),
        refundDue: toMoneyNumberOrNull(currentDraft?.refundDue),
        taxCalculationStatus:
          currentDraft?.taxCalculationStatus ?? "NOT_CALCULATED",
        taxpayerListStatus: currentDraft?.taxpayerListStatus ?? null,
        taxBreakdown,
        finalTaxDue,
        assessableTaxDue,
      },
    };
  } catch (error) {
    console.error("Error fetching filing summary:", error);
    return { success: false, error: "Failed to fetch filing summary" };
  }
}
