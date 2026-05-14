/**
 * Claude AI Integration for Reclassification Scrub Mode
 * -----------------------------------------------------
 * Workflow C only: AI categorizes vendor groups, mapping each to a target account
 * in the client's available COA + master COA, with confidence scoring.
 *
 * 95% confidence threshold → auto_approve
 * 70-94% → needs_review
 * <70%   → flagged
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VendorGroup } from "./qbo-reclass";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-opus-4-7";

const AUTO_APPROVE_THRESHOLD = 0.95;
const NEEDS_REVIEW_THRESHOLD = 0.7;

export interface ReclassClassification {
  vendor_pattern: string;
  target_account_id: string;
  target_account_name: string;
  confidence: number;             // 0-1
  reasoning: string;
  decision: "auto_approve" | "needs_review" | "flagged";
}

export interface ReclassAnalysisResult {
  classifications: ReclassClassification[];
  unclassified: string[];         // vendor patterns AI couldn't confidently map
  warnings: string[];
  summary: string;
}

/**
 * Account available in client's QBO for reclassification (target).
 * Excludes the source account itself.
 */
export interface AvailableAccount {
  qbo_account_id: string;
  account_name: string;
  account_type: string;
  account_subtype: string;
}

const SYSTEM_PROMPT = `You are the IronBooks AI Bookkeeper performing a transaction scrub for a residential painting contractor.

The bookkeeper has selected a single source account that needs cleaning (often a dumping ground like "Uncategorized Expense" or "Ask My Accountant"). Your job: for each vendor group found in that account, map it to the correct target account in the client's COA.

CRITICAL RULES:
1. Confidence 0.95+ ONLY for obvious vendor patterns where the target account is unambiguous (Sherwin-Williams → Paint & Materials).
2. Confidence 0.70-0.94 for likely-correct mappings where context could change the answer (Home Depot → usually Job Supplies, but could be office supplies).
3. Confidence <0.70 for cases where you cannot confidently choose between 2+ targets, OR vendor is unknown.
4. The target account MUST be one of the provided "available accounts". Do NOT invent accounts.
5. Be very conservative with anything tax-sensitive: payroll, tax payments, owner draws, distributions → if unsure, low confidence.
6. The source account is what you're moving FROM. Never suggest moving back to source.
7. Reasoning must be SHORT (one sentence) and reference the vendor specifically.

For painter context, common patterns:
- Sherwin-Williams, Benjamin Moore, Dunn-Edwards, PPG, Para → "Paint & Materials" type accounts (high confidence)
- Home Depot, Lowes, Rona → "Job Supplies" usually (medium-high)
- Shell, Chevron, Esso, Petro-Canada, Costco Gas → "Fuel" / "Auto Expense" type accounts (high)
- Gusto, ADP, Wagepoint, Payworks → Payroll-related (LOW confidence, flag for human)
- State Farm, Intact, Aviva, Wawanesa → Insurance accounts (high)
- Verizon, Rogers, Bell, Telus → Telecom/Utilities (high)
- Stripe, Square, Helcim, PayPal → Revenue/Merchant fees (medium - context-dependent)
- IRS, CRA, State/Provincial tax authorities → FLAG, never confident
- Unknown one-off vendors → low confidence, let bookkeeper decide

Return STRICTLY valid JSON:
{
  "classifications": [
    {
      "vendor_pattern": "string (matches input)",
      "target_account_id": "string (QBO ID from available_accounts)",
      "target_account_name": "string (matches available_accounts name)",
      "confidence": 0.00-1.00,
      "reasoning": "string (one sentence)"
    }
  ],
  "unclassified": ["vendor patterns you couldn't map"],
  "warnings": ["structural concerns"],
  "summary": "one paragraph overview"
}

No markdown fences, no preamble. Just the JSON.`;

export async function classifyVendorGroups(params: {
  clientName: string;
  jurisdiction: "US" | "CA";
  stateProvince: string;
  sourceAccountName: string;
  vendorGroups: VendorGroup[];
  availableAccounts: AvailableAccount[];
}): Promise<ReclassAnalysisResult> {
  // Compact input — Claude doesn't need every transaction, just the vendor summary
  const compactGroups = params.vendorGroups.map((g) => ({
    vendor: g.vendor_pattern,
    sample_name: g.display_name,
    tx_count: g.lines.length,
    total_amount: Math.round(g.total_amount),
    date_range: `${g.earliest_date} to ${g.latest_date}`,
    // Send up to 3 sample memos to give context
    sample_descriptions: g.lines
      .slice(0, 3)
      .map((l) => l.description)
      .filter((d) => d && d.length > 0)
      .slice(0, 3),
  }));

  const compactAccounts = params.availableAccounts.map((a) => ({
    id: a.qbo_account_id,
    name: a.account_name,
    type: a.account_type,
    subtype: a.account_subtype,
  }));

  const userMessage = `
CLIENT: ${params.clientName}
JURISDICTION: ${params.jurisdiction} (${params.stateProvince})
INDUSTRY: Residential Painting Contractor
SOURCE ACCOUNT being scrubbed: "${params.sourceAccountName}"

===== AVAILABLE TARGET ACCOUNTS =====
${JSON.stringify(compactAccounts, null, 2)}

===== VENDOR GROUPS TO CLASSIFY (${compactGroups.length} groups) =====
${JSON.stringify(compactGroups, null, 2)}

Classify each vendor group. Return the structured JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((c) => c.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: {
    classifications: Array<{
      vendor_pattern: string;
      target_account_id: string;
      target_account_name: string;
      confidence: number;
      reasoning: string;
    }>;
    unclassified?: string[];
    warnings?: string[];
    summary?: string;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    throw new Error(
      `Failed to parse Claude reclass output: ${err.message}\nResponse: ${cleaned.slice(0, 500)}`
    );
  }

  // Validate + derive decisions
  const validAccountIds = new Set(params.availableAccounts.map((a) => a.qbo_account_id));
  const warnings = [...(parsed.warnings || [])];
  const classifications: ReclassClassification[] = [];
  const unclassified = [...(parsed.unclassified || [])];

  for (const c of parsed.classifications) {
    if (!validAccountIds.has(c.target_account_id)) {
      warnings.push(`Dropped "${c.vendor_pattern}" → invalid target ID "${c.target_account_id}"`);
      unclassified.push(c.vendor_pattern);
      continue;
    }

    const confidence = Math.max(0, Math.min(1, c.confidence));

    let decision: ReclassClassification["decision"];
    if (confidence >= AUTO_APPROVE_THRESHOLD) decision = "auto_approve";
    else if (confidence >= NEEDS_REVIEW_THRESHOLD) decision = "needs_review";
    else decision = "flagged";

    // Force-flag sensitive vendors regardless of confidence
    const isSensitive =
      /payroll|tax|irs|cra|owner|draw|distribution|gusto|adp|wagepoint|payworks/i.test(
        c.vendor_pattern + " " + c.target_account_name
      );
    if (isSensitive && decision === "auto_approve") {
      decision = "needs_review";
    }

    classifications.push({
      vendor_pattern: c.vendor_pattern,
      target_account_id: c.target_account_id,
      target_account_name: c.target_account_name,
      confidence,
      reasoning: c.reasoning,
      decision,
    });
  }

  return {
    classifications,
    unclassified,
    warnings,
    summary: parsed.summary || "",
  };
}
