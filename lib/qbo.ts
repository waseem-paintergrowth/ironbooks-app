/**
 * QuickBooks Online API Client
 * ----------------------------
 * Handles:
 *  - OAuth 2.0 flow (authorize, exchange code, refresh tokens)
 *  - Reading the client's Chart of Accounts
 *  - Creating, renaming, inactivating accounts
 *  - Reclassifying transactions
 *  - Setting tax codes
 *
 * QBO API docs:
 *  - Account: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/account
 *  - Auth: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *
 * Requires env vars:
 *  - QBO_CLIENT_ID
 *  - QBO_CLIENT_SECRET
 *  - QBO_ENVIRONMENT ('sandbox' or 'production')
 *  - QBO_REDIRECT_URI
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const QBO_BASE = process.env.QBO_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

const QBO_AUTH_BASE = 'https://oauth.platform.intuit.com';
const QBO_DISCOVERY = 'https://developer.api.intuit.com/.well-known/openid_configuration';

// ============== TYPES ==============

export interface QBOAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AccountType: string;
  AccountSubType: string;
  Classification: string;            // 'Asset', 'Liability', 'Equity', 'Revenue', 'Expense'
  Active: boolean;
  SubAccount: boolean;
  ParentRef?: { value: string; name?: string };
  CurrentBalance: number;
  CurrentBalanceWithSubAccounts: number;
  CurrencyRef: { value: string; name?: string };
  Description?: string;
  TaxCodeRef?: { value: string };
  MetaData: {
    CreateTime: string;
    LastUpdatedTime: string;
  };
}

export interface QBOTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

// ============== OAUTH ==============

/**
 * Build the QBO authorize URL. User visits this to grant access.
 */
export function getAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID!,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI!,
    state,
  });
  return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens.
 * Call this in your OAuth callback handler.
 */
export async function exchangeCodeForTokens(code: string): Promise<QBOTokens> {
  const auth = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${QBO_AUTH_BASE}/oauth2/v1/tokens/bearer`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.QBO_REDIRECT_URI!,
    }),
  });

  if (!res.ok) {
    throw new Error(`QBO token exchange failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<QBOTokens> {
  const auth = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${QBO_AUTH_BASE}/oauth2/v1/tokens/bearer`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`QBO token refresh failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

/**
 * Get a valid access token for a client, refreshing if expired.
 */
export async function getValidToken(clientLinkId: string, supabase: ReturnType<typeof createClient<Database>>): Promise<string> {
  const { data: client, error } = await supabase
    .from('client_links')
    .select('qbo_access_token, qbo_refresh_token, qbo_token_expires_at')
    .eq('id', clientLinkId)
    .single();

  if (error || !client) throw new Error('Client not found');

  const expiresAt = new Date(client.qbo_token_expires_at!).getTime();
  const now = Date.now();
  const buffer = 5 * 60 * 1000; // 5 minute buffer

  if (expiresAt > now + buffer) {
    return client.qbo_access_token!;
  }

  // Refresh
  const tokens = await refreshAccessToken(client.qbo_refresh_token!);
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase
    .from('client_links')
    .update({
      qbo_access_token: tokens.access_token,
      qbo_refresh_token: tokens.refresh_token,
      qbo_token_expires_at: newExpiresAt,
    })
    .eq('id', clientLinkId);

  return tokens.access_token;
}

// ============== CORE REQUEST ==============

async function qboRequest<T>(
  realmId: string,
  accessToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${QBO_BASE}/v3/company/${realmId}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO API ${res.status}: ${body}`);
  }

  return res.json();
}

// ============== ACCOUNTS ==============

/**
 * Pull the entire Chart of Accounts for a client.
 */
export async function fetchAllAccounts(realmId: string, accessToken: string): Promise<QBOAccount[]> {
  const query = encodeURIComponent('SELECT * FROM Account MAXRESULTS 1000');
  const data = await qboRequest<{ QueryResponse: { Account?: QBOAccount[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.Account || [];
}

/**
 * Create a new account in QBO.
 * For sub-accounts, set parentRef to the parent's QBO ID.
 */
export async function createAccount(
  realmId: string,
  accessToken: string,
  params: {
    name: string;
    accountType: string;
    accountSubType: string;
    parentRefId?: string;
    description?: string;
    taxCodeRef?: string;
  }
): Promise<QBOAccount> {
  const body: any = {
    Name: params.name,
    AccountType: params.accountType,
    AccountSubType: params.accountSubType,
  };

  if (params.parentRefId) {
    body.ParentRef = { value: params.parentRefId };
    body.SubAccount = true;
  }
  if (params.description) body.Description = params.description;
  if (params.taxCodeRef) body.TaxCodeRef = { value: params.taxCodeRef };

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.Account;
}

/**
 * Rename an existing account (preserves history + transactions).
 */
export async function renameAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  newName: string,
  options?: { newSubType?: string; taxCodeRef?: string }
): Promise<QBOAccount> {
  const body: any = {
    Id: accountId,
    SyncToken: syncToken,
    Name: newName,
  };

  if (options?.newSubType) body.AccountSubType = options.newSubType;
  if (options?.taxCodeRef) body.TaxCodeRef = { value: options.taxCodeRef };

  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?operation=update&sparse=true&minorversion=70',
    { method: 'POST', body: JSON.stringify(body) }
  );

  return data.Account;
}

/**
 * Inactivate an account (QBO doesn't allow true deletion if there's history).
 */
export async function inactivateAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string
): Promise<QBOAccount> {
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?operation=update&sparse=true&minorversion=70',
    {
      method: 'POST',
      body: JSON.stringify({
        Id: accountId,
        SyncToken: syncToken,
        Active: false,
      }),
    }
  );

  return data.Account;
}

/**
 * Move a sub-account under a different parent.
 */
export async function reparentAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  syncToken: string,
  newParentId: string
): Promise<QBOAccount> {
  const data = await qboRequest<{ Account: QBOAccount }>(
    realmId,
    accessToken,
    '/account?operation=update&sparse=true&minorversion=70',
    {
      method: 'POST',
      body: JSON.stringify({
        Id: accountId,
        SyncToken: syncToken,
        ParentRef: { value: newParentId },
        SubAccount: true,
      }),
    }
  );

  return data.Account;
}

// ============== TRANSACTIONS ==============

export interface QBOTransaction {
  Id: string;
  SyncToken: string;
  TxnDate: string;
  TotalAmt: number;
  PrivateNote?: string;
  Line: Array<{
    Id?: string;
    DetailType: string;
    Amount: number;
    AccountBasedExpenseLineDetail?: { AccountRef: { value: string } };
    JournalEntryLineDetail?: {
      PostingType: 'Debit' | 'Credit';
      AccountRef: { value: string };
    };
  }>;
}

/**
 * Fetch all transactions posted to a specific account.
 * Used before reclassification to know what we're moving.
 */
export async function fetchTransactionsForAccount(
  realmId: string,
  accessToken: string,
  accountId: string,
  txTypes: string[] = ['Purchase', 'Bill', 'JournalEntry', 'Deposit']
): Promise<{ type: string; transactions: any[] }[]> {
  const results = [];

  for (const type of txTypes) {
    const query = encodeURIComponent(
      `SELECT * FROM ${type} WHERE Line.AccountBasedExpenseLineDetail.AccountRef='${accountId}' MAXRESULTS 1000`
    );
    try {
      const data = await qboRequest<any>(
        realmId,
        accessToken,
        `/query?query=${query}`
      );
      const txs = data.QueryResponse[type] || [];
      if (txs.length > 0) results.push({ type, transactions: txs });
    } catch {
      // some types don't support this query - skip silently
    }
  }

  return results;
}

/**
 * Reclassify a single transaction line from one account to another.
 * QBO requires the full transaction object to be re-posted.
 */
export async function reclassifyTransaction(
  realmId: string,
  accessToken: string,
  txnType: string,
  transaction: QBOTransaction,
  fromAccountId: string,
  toAccountId: string
): Promise<QBOTransaction> {
  // Update each line that points to fromAccountId
  const updatedLines = transaction.Line.map((line) => {
    if (line.AccountBasedExpenseLineDetail?.AccountRef.value === fromAccountId) {
      return {
        ...line,
        AccountBasedExpenseLineDetail: {
          ...line.AccountBasedExpenseLineDetail,
          AccountRef: { value: toAccountId },
        },
      };
    }
    if (line.JournalEntryLineDetail?.AccountRef.value === fromAccountId) {
      return {
        ...line,
        JournalEntryLineDetail: {
          ...line.JournalEntryLineDetail,
          AccountRef: { value: toAccountId },
        },
      };
    }
    return line;
  });

  const data = await qboRequest<any>(
    realmId,
    accessToken,
    `/${txnType.toLowerCase()}?minorversion=70`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...transaction,
        Line: updatedLines,
      }),
    }
  );

  return data[txnType];
}

// ============== TAX CODES ==============

export interface QBOTaxCode {
  Id: string;
  Name: string;
  Description?: string;
  TaxGroup: boolean;
  Active: boolean;
}

/**
 * Get all tax codes available in the client's QBO.
 * Used to map Canadian GST/HST/PST to the right TaxCodeRef.
 */
export async function fetchTaxCodes(realmId: string, accessToken: string): Promise<QBOTaxCode[]> {
  const query = encodeURIComponent('SELECT * FROM TaxCode MAXRESULTS 100');
  const data = await qboRequest<{ QueryResponse: { TaxCode?: QBOTaxCode[] } }>(
    realmId,
    accessToken,
    `/query?query=${query}`
  );
  return data.QueryResponse.TaxCode || [];
}

// ============== BATCH OPERATIONS ==============

/**
 * Batch operation (up to 30 items per call - QBO limit).
 * Use for high-volume reclassifications.
 */
export async function batchOperation(
  realmId: string,
  accessToken: string,
  operations: Array<{ operation: string; resource: string; payload: any; bId: string }>
): Promise<any> {
  return qboRequest(realmId, accessToken, '/batch?minorversion=70', {
    method: 'POST',
    body: JSON.stringify({
      BatchItemRequest: operations.map(op => ({
        bId: op.bId,
        operation: op.operation,
        [op.resource]: op.payload,
      })),
    }),
  });
}

// ============== RATE LIMITER ==============
// QBO limit: 500 requests/minute per realm.
// Simple in-memory limiter — use Redis for production multi-instance.
class RateLimiter {
  private timestamps: Map<string, number[]> = new Map();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute = 450) {
    this.maxPerMinute = maxPerMinute;
  }

  async throttle(key: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    const list = (this.timestamps.get(key) || []).filter(t => t > cutoff);

    if (list.length >= this.maxPerMinute) {
      const oldest = list[0];
      const waitMs = 60_000 - (now - oldest) + 100;
      await new Promise(r => setTimeout(r, waitMs));
      return this.throttle(key);
    }

    list.push(now);
    this.timestamps.set(key, list);
  }
}

export const qboRateLimiter = new RateLimiter();

// ============== COMPANY INFO ==============

export interface QBOCompanyInfo {
  CompanyName: string;
  LegalName?: string;
  Country?: string;
  CompanyAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Country?: string;
  };
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
}

/**
 * Fetch company name + jurisdiction from a freshly-connected QBO company.
 * Call this immediately after exchangeCodeForTokens().
 */
export async function fetchCompanyInfo(
  realmId: string,
  accessToken: string
): Promise<QBOCompanyInfo> {
  const data = await qboRequest<{ CompanyInfo: QBOCompanyInfo }>(
    realmId,
    accessToken,
    `/companyinfo/${realmId}`
  );
  return data.CompanyInfo;
}
