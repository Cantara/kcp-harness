# Budget Tracking

The harness tracks knowledge access costs via an append-only budget ledger. This ensures agents can't exceed their knowledge budget.

## How It Works

1. Each `kcp_load` call records the cost of loaded units
2. Running totals are maintained per currency
3. If a load would exceed the budget ceiling, the entire load is **rejected** (no partial loads)
4. Every spend/rejection is logged to the audit log

## Configuration

Set a budget ceiling in `harness.yaml`:

```yaml
governance:
  policy:
    budget:
      amount: 1.00
      currency: USDC
    context_budget: 50000  # token budget
```

## Querying

Use the `harness_budget` MCP tool:

```json
{
  "ceiling": { "amount": 1.00, "currency": "USDC" },
  "spent": { "USDC": 0.25 },
  "remaining": { "USDC": 0.75 },
  "entries": [...]
}
```

## Ledger Properties

| Property | Description |
|---|---|
| **Append-only** | Entries can't be modified or deleted |
| **Itemized** | Each entry records source, description, cost, and running total |
| **Per-currency** | Running totals tracked per currency (supports multi-currency) |
| **Ceiling-enforced** | Loads that would exceed ceiling are rejected atomically |
| **Sequenced** | Each entry has a monotonic sequence number |

## No Partial Loads

If a `kcp_load` would push spend over the ceiling, the **entire load** is rejected — not just the units that exceed the budget. This prevents the agent from getting an incomplete knowledge set that could lead to incorrect conclusions.
