/**
 * Claude AI Integration for COA Cleanup
 * --------------------------------------
 * Sends the client's QBO Chart of Accounts to Claude along with the IronBooks
 * Master COA template. Claude returns structured suggestions for each account:
 *   - keep / rename / delete / flag
 *   - confidence score
 *   - reasoning
 *
 * Uses Claude Opus for the analysis (best at structured reasoning + nuance).
 *
 * Requires env vars:
 *  - ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import type { QBOAccount } from './qbo';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-opus-4-7';

// ============== TYPES ==============

export interface MasterCOAEntry {
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean;
  qbo_account_type: string;
  qbo_account_subtype: string;
  section: string;
  notes: string;
  is_required: boolean;
  tax_treatment: any;
}

export interface AISuggestion {
  qbo_account_id: string;
  current_name: string;
  action: 'keep' | 'rename' | 'delete' | 'flag';
  target_master_account?: string;     // for rename: which master account to map to
  new_parent_account?: string;
  confidence: number;
  reasoning: string;
  flag_reason?: string;
}

export interface AnalysisResult {
  suggestions: AISuggestion[];
  missing_required_accounts: string[];      // master accounts not in client's COA
  warnings: string[];
  summary: string;
}

// ============== SYSTEM PROMPT ==============

const SYSTEM_PROMPT = `You are the IronBooks AI Bookkeeper - a senior accountant specializing in painting contractors.

Your job is to analyze a painting contractor's QuickBooks Chart of Accounts (COA) and map each account to the IronBooks Master COA template.

You will be given:
1. The IronBooks Master COA (the standard we want every painter to follow)
2. The client's current QBO COA pulled from their account

For each account in the client's COA, decide:
- KEEP: the account already matches the master perfectly
- RENAME: rename it to match a master account (specify which master account)
- DELETE: it's truly unused and has 0 transactions
- FLAG: it has special circumstances requiring human (Lisa) review

CRITICAL RULES:
1. NEVER suggest DELETE for any account with transaction_count > 0. Suggest FLAG instead.
2. FLAG anything tax-related, payroll-related, equity, or with significant balances ($10k+).
3. FLAG any account with words like "Owner", "Draws", "Distribution", "Loan", "Note Payable".
4. FLAG if the QBO account_type doesn't match what the master template uses (this is a structural concern).
5. Be conservative with confidence scores. Use 0.90+ ONLY for obvious matches. Use 0.70-0.89 for likely-but-needs-glance. Below 0.70 should usually be FLAG.
6. Reasoning must be SHORT (max 12 words), specific to this client's data, not generic. Skip filler words like "this account".
7. Match account_subtype carefully - "EntertainmentMeals" vs "Auto" vs "Insurance" must be exact.

Also identify any REQUIRED master accounts that are MISSING from the client's COA - those will need to be created.

Return STRICTLY valid JSON matching this schema:
{
  "suggestions": [
    {
      "qbo_account_id": "string",
      "current_name": "string",
      "action": "keep" | "rename" | "delete" | "flag",
      "target_master_account": "string (only for rename)",
      "new_parent_account": "string (only if hierarchy needs change)",
      "confidence": 0.00-1.00,
      "reasoning": "string (one sentence)",
      "flag_reason": "string (only for flag)"
    }
  ],
  "missing_required_accounts": ["array of master account names"],
  "warnings": ["array of structural concerns"],
  "summary": "one paragraph summary of the cleanup needed"
}

Do not include any text outside the JSON. No markdown code fences. Just the JSON object.`;

// ============== ANALYZE ==============

/**
 * Maximum number of client accounts to send to Claude in a single API call.
 * Each batch produces ~80 output tokens/account; at 40 accounts that's ~3200
 * output tokens, well within the 16K max_tokens budget.
 * 176 accounts → 5 batches; 300 accounts → 8 batches; etc.
 */
const BATCH_SIZE = 40;

export async function analyzeCOA(params: {
  clientName: string;
  jurisdiction: 'US' | 'CA';
  stateProvince: string;
  clientAccounts: Array<QBOAccount & { transaction_count?: number }>;
  masterCOA: MasterCOAEntry[];
}): Promise<AnalysisResult> {
  // Compact master COA once (constant across all batches)
  const compactMaster = params.masterCOA.map(m => ({
    name: m.account_name,
    parent: m.parent_account_name,
    is_parent: m.is_parent,
    type: m.qbo_account_type,
    subtype: m.qbo_account_subtype,
    section: m.section,
    required: m.is_required,
    tax_note: m.tax_treatment?.note,
  }));

  // Single batch path — small clients
  if (params.clientAccounts.length <= BATCH_SIZE) {
    const result = await _analyzeBatch({
      clientName: params.clientName,
      jurisdiction: params.jurisdiction,
      stateProvince: params.stateProvince,
      batchAccounts: params.clientAccounts,
      compactMaster,
      batchInfo: null,
    });
    return validateAnalysis(result, params.clientAccounts);
  }

  // Multi-batch path — split client COA into chunks
  const batches: Array<typeof params.clientAccounts> = [];
  for (let i = 0; i < params.clientAccounts.length; i += BATCH_SIZE) {
    batches.push(params.clientAccounts.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `[analyzeCOA] Splitting ${params.clientAccounts.length} accounts into ${batches.length} batches of up to ${BATCH_SIZE}`
  );

  const batchResults: AnalysisResult[] = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`[analyzeCOA] Running batch ${i + 1}/${batches.length} (${batches[i].length} accounts)...`);
    const result = await _analyzeBatch({
      clientName: params.clientName,
      jurisdiction: params.jurisdiction,
      stateProvince: params.stateProvince,
      batchAccounts: batches[i],
      compactMaster,
      batchInfo: { current: i + 1, total: batches.length },
    });
    batchResults.push(result);
  }

  // Merge all batch outputs into a single AnalysisResult
  const merged = mergeAnalysisResults(batchResults, params.masterCOA, params.clientAccounts);
  return validateAnalysis(merged, params.clientAccounts);
}

/**
 * Run one Claude call for a subset of the client's accounts.
 * Pure - no DB writes, no merging - just sends accounts and parses the response.
 */
async function _analyzeBatch(args: {
  clientName: string;
  jurisdiction: 'US' | 'CA';
  stateProvince: string;
  batchAccounts: Array<QBOAccount & { transaction_count?: number }>;
  compactMaster: any[];
  batchInfo: { current: number; total: number } | null;
}): Promise<AnalysisResult> {
  const compactClient = args.batchAccounts.map(a => ({
    id: a.Id,
    name: a.Name,
    type: a.AccountType,
    subtype: a.AccountSubType,
    parent: a.ParentRef?.name,
    balance: a.CurrentBalance,
    tx_count: a.transaction_count ?? 0,
    active: a.Active,
  }));

  const batchHeader = args.batchInfo
    ? `\nBATCH: ${args.batchInfo.current} of ${args.batchInfo.total} (this batch has ${args.batchAccounts.length} accounts; analyze ONLY these)`
    : '';

  const userMessage = `
CLIENT: ${args.clientName}
JURISDICTION: ${args.jurisdiction} (${args.stateProvince})
INDUSTRY: Residential Painting Contractor${batchHeader}

===== IRONBOOKS MASTER COA (${args.jurisdiction}) =====
${JSON.stringify(args.compactMaster, null, 2)}

===== CLIENT'S CURRENT COA (from QuickBooks) =====
${JSON.stringify(compactClient, null, 2)}

Analyze each client account in this batch and return your structured JSON response.
If this is a batch, do NOT worry about missing_required_accounts — that's calculated separately. Return [] for missing_required_accounts.`.trim();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userMessage },
    ],
  });

  if (response.stop_reason === 'max_tokens') {
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const where = args.batchInfo ? `batch ${args.batchInfo.current}/${args.batchInfo.total}` : 'single call';
    throw new Error(
      `Claude hit the max_tokens cap during analysis (${where}, ${args.batchAccounts.length} accounts, used ${outputTokens} output tokens, ${inputTokens} input). ` +
      `Reduce BATCH_SIZE in lib/claude.ts.`
    );
  }

  const textBlock = response.content.find(c => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  const raw = textBlock.text.trim();
  const cleaned = raw
    .replace(/^```json\s*/, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned) as AnalysisResult;
  } catch (err: any) {
    const preview = cleaned.length > 1000
      ? cleaned.slice(0, 500) + '\n...[truncated]...\n' + cleaned.slice(-500)
      : cleaned;
    const where = args.batchInfo ? `batch ${args.batchInfo.current}/${args.batchInfo.total}` : 'single call';
    throw new Error(
      `Failed to parse Claude response as JSON (${where}): ${err.message}\n` +
      `Output tokens: ${response.usage?.output_tokens ?? 'unknown'} of 16000. Stop reason: ${response.stop_reason}\n\n` +
      `Response preview:\n${preview}`
    );
  }
}

/**
 * Merge per-batch results into a single AnalysisResult.
 * - Concatenates all suggestions.
 * - Deduplicates warnings.
 * - Computes missing_required_accounts deterministically (no AI needed).
 * - Synthesizes a summary.
 */
function mergeAnalysisResults(
  batchResults: AnalysisResult[],
  masterCOA: MasterCOAEntry[],
  allClientAccounts: Array<QBOAccount & { transaction_count?: number }>
): AnalysisResult {
  const allSuggestions: AISuggestion[] = batchResults.flatMap(r => r.suggestions || []);
  const allWarnings: string[] = Array.from(
    new Set(batchResults.flatMap(r => r.warnings || []))
  );

  // Compute missing required master accounts deterministically.
  // A master required (leaf) account is "missing" if:
  //   - No client account already has that exact name, AND
  //   - No suggestion is renaming to it
  const clientNamesLower = new Set(
    allClientAccounts.map(a => (a.Name || '').toLowerCase().trim())
  );
  const renameTargetsLower = new Set(
    allSuggestions
      .filter(s => s.action === 'rename' && s.target_master_account)
      .map(s => (s.target_master_account || '').toLowerCase().trim())
  );

  const missing = masterCOA
    .filter(m => m.is_required && !m.is_parent)
    .filter(m => {
      const n = m.account_name.toLowerCase().trim();
      return !clientNamesLower.has(n) && !renameTargetsLower.has(n);
    })
    .map(m => m.account_name);

  const counts = {
    keep: allSuggestions.filter(s => s.action === 'keep').length,
    rename: allSuggestions.filter(s => s.action === 'rename').length,
    delete: allSuggestions.filter(s => s.action === 'delete').length,
    flag: allSuggestions.filter(s => s.action === 'flag').length,
  };

  const summary =
    `Analyzed ${allSuggestions.length} client accounts across ${batchResults.length} batches. ` +
    `Recommendations: ${counts.keep} keep, ${counts.rename} rename, ${counts.delete} delete, ${counts.flag} flag for review. ` +
    `${missing.length} required master accounts are missing and need to be created.`;

  return {
    suggestions: allSuggestions,
    missing_required_accounts: missing,
    warnings: allWarnings,
    summary,
  };
}

// ============== VALIDATION ==============

/**
 * Sanity-check Claude's output before we trust it for execution.
 * Auto-corrects unsafe suggestions (e.g., delete with transactions → flag).
 */
function validateAnalysis(
  analysis: AnalysisResult,
  clientAccounts: Array<QBOAccount & { transaction_count?: number }>
): AnalysisResult {
  const accountById = new Map(clientAccounts.map(a => [a.Id, a]));
  const warnings = [...(analysis.warnings || [])];

  for (const s of analysis.suggestions) {
    const account = accountById.get(s.qbo_account_id);
    if (!account) continue;

    const txCount = account.transaction_count ?? 0;

    // SAFETY: never delete with transactions
    if (s.action === 'delete' && txCount > 0) {
      warnings.push(`Forced flag: "${s.current_name}" had delete suggested but has ${txCount} transactions`);
      s.action = 'flag';
      s.flag_reason = `Has ${txCount} transactions - cannot delete`;
      s.confidence = Math.min(s.confidence, 0.5);
    }

    // SAFETY: flag anything Equity, Liability, large-balance
    if (account.Classification === 'Equity' || account.Classification === 'Liability') {
      if (s.action !== 'flag') {
        warnings.push(`Forced flag: "${s.current_name}" is ${account.Classification} - needs Lisa review`);
        s.action = 'flag';
        s.flag_reason = `${account.Classification} account requires manual review`;
      }
    }

    // SAFETY: flag large balances
    if (Math.abs(account.CurrentBalance) > 50000 && s.action === 'rename') {
      warnings.push(`Caution: "${s.current_name}" has $${account.CurrentBalance.toLocaleString()} balance`);
    }

    // SAFETY: clamp confidence
    s.confidence = Math.max(0, Math.min(1, s.confidence));

    // SAFETY: rename requires target
    if (s.action === 'rename' && !s.target_master_account) {
      s.action = 'flag';
      s.flag_reason = 'Rename suggested but no target master account specified';
    }
  }

  return { ...analysis, warnings };
}

// ============== SINGLE ACCOUNT REVIEW ==============

/**
 * Re-analyze a single flagged account with more context.
 * Used when Lisa is reviewing flagged items and wants a deeper opinion.
 */
export async function deepReviewAccount(params: {
  account: QBOAccount & { transaction_count?: number };
  recentTransactions: Array<{ date: string; amount: number; description: string }>;
  jurisdiction: 'US' | 'CA';
  masterCOA: MasterCOAEntry[];
}): Promise<{
  recommended_action: 'keep' | 'rename' | 'delete' | 'flag' | 'manual_split';
  recommended_target?: string;
  reasoning: string;
  considerations: string[];
}> {
  const userMessage = `Analyze this flagged account in detail:

ACCOUNT:
${JSON.stringify({
    name: params.account.Name,
    type: params.account.AccountType,
    subtype: params.account.AccountSubType,
    balance: params.account.CurrentBalance,
    classification: params.account.Classification,
    tx_count: params.account.transaction_count,
  }, null, 2)}

RECENT TRANSACTIONS (last 20):
${JSON.stringify(params.recentTransactions.slice(0, 20), null, 2)}

AVAILABLE MASTER ACCOUNTS:
${params.masterCOA.filter(m => !m.is_parent).map(m => m.account_name).join(', ')}

Provide your recommendation as JSON:
{
  "recommended_action": "keep" | "rename" | "delete" | "flag" | "manual_split",
  "recommended_target": "string (if rename)",
  "reasoning": "2-3 sentences explaining your call",
  "considerations": ["important factors Lisa should know"]
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find(c => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }

  const cleaned = textBlock.text
    .replace(/^```json\s*/, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(cleaned);
}
