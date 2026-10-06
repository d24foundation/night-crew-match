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

## Backlog
- P0: Push notifications (need google-services.json)
- P1: Profile photo upload (object storage), real-time chat (websockets), map view of parties
- P1: Report/block users, age verification
- P2: Invite-link sharing with referral rewards, party ratings, check-in QR
