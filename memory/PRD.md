# After Party — PRD

## Original problem statement
Mobile app that connects people for after-parties when clubs close (or during the night): one person brings the house, others bring drinks, everyone chips in. International scale, London-first (UK). Premium £3.99, Super Premium £7.99. Viral, simple, catchy.

## User choices
- Auth: JWT email/password + Emergent Google + Apple sign-in (iOS)
- Payments: RevenueCat in-app subscriptions + Stripe card checkout (GBP)
- Features: party listings by city + group chat + swipe-to-match + match chat
- Premium: unlimited joins/likes + boost. Super: host priority, see who's going, verified badge
- Gemini AI: party hype writer + match wingman icebreaker
- Push notifications: requested, waiting on google-services.json from user

## Architecture
- Backend: FastAPI (/app/backend/server.py), MongoDB, JWT (HS256, 30 days), bcrypt, emergentintegrations (Stripe, Gemini 3 Flash)
- Frontend: Expo Router. Tabs: Parties / Match / Chats / Profile (NativeTabs on iOS 26+). Stack screens: party/[id], party/create, chat/[id], premium, edit-profile, login
- Tier = the higher of the Stripe tier (30-day expiry, stored on the server) and the RevenueCat tier (sent in the X-Store-Tier header)

## Implemented (2026-06)
- Login/register, Google, Apple (iOS build only)
- Party feed with city chips (All, London, Manchester, Ibiza, Berlin, Paris, Amsterdam, NYC, Dubai, Lagos); create party; join with role (chip in / drinks / house); address hidden until you join; leave
- Free limits: 3 joins and 25 likes per 24h (returns 402, which opens the paywall)
- Swipe deck with gestures; demo users always match back; match modal
- Group and match chats (polling)
- Premium paywall: RevenueCat (test store in preview) + Stripe checkout with payment-status polling and webhook
- Gemini AI: /api/ai/party-hype, /api/ai/icebreaker/{match_id}
- Seed data: 8 demo users and 6 parties (London-heavy)
- AI Vibe Matcher (/api/ai/vibe-match) card at the top of the feed
- Apple sign-in (/api/auth/apple, JWKS-verified, iOS build only)
- Emergent push notifications: /api/register-push; pushes on new match, chat message, someone joins your party; tap opens the right screen; in-app permission sheet with an Open Settings nudge. googleServicesFile still to be added once the user uploads google-services.json
- New neon wordmark: italic "AFTER" (white, pink glow) + "PARTY" (lime glow) + pink dot
- Expo Go safety: expo-notifications is only loaded in real builds (src/push-env.ts); Expo Go/web run without push so the app never crashes at startup
- Pricing verified in GBP everywhere: backend PLANS (3.99/7.99, currency "gbp"), Stripe checkout, RevenueCat products, paywall UI
- Login wordmark scales with screen width (85% of content width, shrink-to-fit on native) so it never overflows or leaves a gap
- Paywall plan cards: header wraps (name + pill) with a non-shrinking price so £3.99/£7.99 are always visible on narrow phones
- Party Map: parties have lat/lng (+distance_km when ?lat&lng); feed list/map toggle, "Near me" chip, contextual location permission (src/location.tsx); native react-native-maps pins (src/party-map.tsx), web fallback closest-first list (party-map.web.tsx); create party "pin at my location"
- Profile photos: POST /api/me/photo → Emergent object storage, served via GET /api/files/{id}; picker sheet (library/camera with Settings nudge) on Profile + Edit profile; Avatar resolves relative URLs
- Invite links: GET /parties/{id}/invite (host), GET /invites/{code}, POST /invites/{code}/accept (bypasses free join limit); /invite/[code] landing screen, share via Share sheet (clipboard on web); pending invite preserved through login
- Safety: block/unblock/report endpoints; blocked users hidden from discover, matches, chats, feed, messages; SafetySheet on swipe, match chat header, party chat long-press, party detail; Blocked users list in Profile
- Live chat: WebSocket /api/ws/chats/{id} (messages + typing), polling fallback; Party ratings (host trust score); Check-in QR door passes + host scanner; 18+ age verification (DOB at signup, AgeGate for social logins)
- Credits economy (GBP one-off via Stripe): £1=10, £2=25, £5=70; spend on boost (5), extra join (2), promote party (10); ledger at /credits
- Marketing: referral codes (+5 credits each side, /r/<code>), AI promo captions (/parties/{id}/promo), one-tap share, paid party promotion pinned to feed top
- Security: per-IP rate limits on auth/upload/payments/reports (429), security headers (HSTS, nosniff, DENY, Referrer-Policy), image magic-byte validation, origin validation on checkout, atomic credit debits
- Host payouts: guests pay chip-in via Stripe (GBP) → host wallet (10% platform fee), /wallet with payout method (bank/PayPal/Revolut, masked) and payout requests (min £5, status processing)
- Smart reminders: /reminders/upcoming banner on feed (starts in X min + directions); backend loop pushes "1 hour to go" to guests/host
- Weekend streaks: nights recorded on check-in/rating for Fri–Sun parties; consecutive-weekend streak, credits reward min(streak,5), badges at 1/3/6/10; StreakCard on profile
- RevenueCat: annual packages added via proxy ($rc_annual £29.99, super_annual £59.99); paywall monthly/yearly toggle; Customer Center "Manage subscription" (native builds)
- App icon/splash/adaptive icon/favicon generated from the user's uploaded logo (assets/images/*)
- RevenueCat: 7-day free trial (P1W) on both annual packages; paywall shows "7 DAYS FREE" + trial banner
- Split the bill: /chats/{party}/bills CRUD, equal split, pay share via Stripe → creator wallet (no fee), cash mark-paid, ws "bill" refresh; BillsSheet in party chats
- Host ID verification: /me/verify-host (ID + selfie → private storage), admin review via x-admin-secret (ADMIN_SECRET in backend/.env), host_verified shield on parties; /verify-host screen
- Admin panel (/admin, admins = ADMIN_EMAILS in backend/.env or is_admin flag; x-admin-secret still works server-side): KPIs & revenue by source, host ID review with private image viewer, report moderation (dismiss/warn/suspend; suspended accounts are blocked at auth)

## Backlog
- P0: Push notifications (need google-services.json)
- P1: Real-time chat (websockets)
- P1: Age verification
- P2: Party ratings, check-in QR, referral rewards
- Note: Android production builds need a Google Maps API key in app.json (android.config.googleMaps.apiKey); Expo Go and iOS work without it
