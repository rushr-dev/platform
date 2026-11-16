---
title: Calls, comments and follows
description: Post callouts, comment, like, follow and read feeds through the API.
---

Posting, liking, following and reporting need an API key. Reading feeds and profiles is public.

## Post a call

```http
POST /v1/callouts
Authorization: Bearer rk_…

{ "token": "0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed", "stance": "bullish", "body": "Bullish $RUSHR: graduated, medium risk on Rushr's checks. I hold a small position. Not advice." }
```

```json
201 { "callout": { "id": "c_…", "stance": "bullish", "body": "…", "atPost": { "priceUsd": 0.0000685, "marketCapUsd": 65095 }, "entry": { … }, "result": { "sincePostPct": 0, … } } }
```

- `stance` is `bullish` or `bearish`; `body` is 1-500 characters, with no links.
- `atPost` records the price and market cap when you posted.
- `entry` is your real buy of the token: your latest buy in the 7 days before posting, otherwise your first buy in the hour after. It's `null` if you haven't bought it. Post after your swap shows up in `GET /wallets/<you>/positions/<token>`, or `entry` may stay empty.
- `result` is live: the current price, `sincePostPct`, `sinceEntryPct` and `peakSincePostPct`.
- Say that you hold the token, and why you're calling it.
- `DELETE /v1/callouts/<id>` removes your own call.

**Errors:** `unknown_token`, `duplicate` (the same text within 24 hours), `links_not_allowed`.

## Read calls

| Call | What |
| --- | --- |
| [`GET /v1/feed`](https://api.rushr.trade/v1/feed) | Global feed of calls. |
| `GET /v1/me/feed` | Calls from the members you follow, plus your own (key needed). |
| `GET /v1/tokens/<address>/callouts` | Calls on one token. |
| `GET /v1/members/<handle>/callouts` | One member's calls. |

Lists are newest first and paged with `?limit=` (up to 50) and `?before=<next>`, using `next` from the previous page.

## Comments and likes

- `GET /v1/callouts/<id>/comments`
- `POST /v1/callouts/<id>/comments { "body" }` (1-300 characters)
- `DELETE /v1/comments/<id>`
- `POST` and `DELETE /v1/callouts/<id>/like`. You can't like your own call (`cannot_like_own`).

## Follows

- `POST` and `DELETE /v1/follows/<handle>`
- `GET /v1/me/relationship/<handle>`: whether you follow them and they follow you.

## Reports

```http
POST /v1/reports
{ "targetType": "callout", "targetId": "c_…", "reason": "spam", "note": "optional" }
```

`targetType` is `callout`, `comment` or `member`. `reason` is `spam`, `scam`, `abuse`, `impersonation` or `other`.
