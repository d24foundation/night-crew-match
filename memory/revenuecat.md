# RevenueCat — integrated (2026-06)
## Identifiers
- rc_project_id: proj29b05695
- apple_app_id: app60658077db
- play_app_id: app37dc98e128
- entitlement_lookup_key: pro
- offering_lookup_key: default
- Packages:
  - $rc_monthly -> prod9dc2383667 (Premium £3.99 / P1M, no trial)
  - super_monthly -> prod907364cb84 (Super Premium £7.99 / P1M, no trial)
  - $rc_annual deleted
- Dashboard: https://app.revenuecat.com/projects/proj29b05695
- Tier detection client-side: active entitlement productIdentifier vs super_monthly package product id. Client sends X-Store-Tier header so backend perk checks honor it.

## Status check
curl -sS -H "$AUTH" "$INTEGRATION_PROXY_URL/internal/revenuecat/projects/209d2d50-abee-4583-8602-019458200cdb/status"

## Updates (proxy only)
- POST $INTEGRATION_PROXY_URL/internal/revenuecat/projects/209d2d50-abee-4583-8602-019458200cdb/products (upsert)
- DELETE .../products/%24rc_monthly
- Re-run /setup to recover identifiers.

## Going live (user steps): upload App Store .p8 / Play service JSON in RC dashboard, set up payments profiles, create matching store products with same IDs, then TestFlight / internal testing. See FAQ in payments panel.
