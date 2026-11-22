# TowerOfHan: voice replies to HN (research, 22 Nov 2026)

[V] = read from a primary source today. [I] = inferred. [U] = unverified. I did not log in, post, or create accounts.

## 1. HN rules on generated / AI-edited text
- Guidelines, "In Comments", exact text from the live page: "Don't post generated text or AI-edited text. HN is for conversation between humans." [V] https://news.ycombinator.com/newsguidelines.html
- "In Submissions": "Please don't put generated text in HN posts. Write your text yourself—HN is for sharing between humans. For the same reason, please don't automate posting." [V] same page
- Guidelines and FAQ never mention third-party clients [V] https://news.ycombinator.com/newsfaq.html
- dang, Mar 2026: the rule "has been around for years, but only in case law" https://news.ycombinator.com/item?id=47341726 ; against the rules to "write bots to post things" https://news.ycombinator.com/item?id=47342045 ; the AI-edited clause targets people who "run this through ChatGPT to fix my grammar and spelling", applied "cautiously and with care" https://news.ycombinator.com/item?id=47342616 ; "We'd rather hear you in your own voice, even at a cost of misunderstanding your intent sometimes." https://news.ycombinator.com/item?id=47346253
- Speech-to-text: no dang statement found [U]. [I] Raw STT of the user's own words is their own text; any LLM rewrite is "AI-edited text" and breaks the rule. Keep punctuation fixes deterministic and let the user edit.
- Third-party apps: "not cool that some third-party apps are modifying the shared space of the community" https://news.ycombinator.com/item?id=24335289 ; no official write API, scraping write clients exist https://news.ycombinator.com/item?id=19227509 ; robots.txt sets Crawl-delay 30 and disallows /login and /reply? https://news.ycombinator.com/robots.txt

## 2. Write mechanics
Live HTML, logged out [V]:
- Reply link: `reply?id=<commentId>&goto=item%3Fid%3D<storyId>%23<commentId>`. Logged-out GET says "You have to be logged in to reply." https://news.ycombinator.com/item?id=50589618
- Form: `<form action="comment" method="post">`, hidden `parent`, `goto`, `hmac` (40 hex), textarea `text` (same page).
- Login: form posts to its own URL with `acct`, `pw`; sign-up adds hidden `creating=t`; no `goto` field https://news.ycombinator.com/login

Maintained clients' source [V]:
- Session route (iOS Hackers): cookie named `user`; GET the reply page, POST every form field to `/comment`; HN may reply `/x?fnop=commconfirm` (resubmit once) or "You're posting too fast"; no comment id returned, so re-read the thread before any retry. https://github.com/weiran/Hackers/blob/master/Data/Sources/Data/PostRepository+Commenting.swift , https://github.com/weiran/Hackers/blob/master/Data/Sources/Data/AuthenticationRepository.swift
- Credentials route (Hacki, Harmonic, Materialistic): POST `/comment` with `acct`, `pw`, `parent`, `text`, no hmac; 302 = success. https://github.com/Livinglist/Hacki/blob/master/lib/repositories/post_repository.dart , https://github.com/SimonHalvdansson/Harmonic-HN/blob/main/core/src/commonMain/kotlin/com/simon/harmonichackernews/network/HackerNewsActionRepository.kt , https://github.com/hidroh/materialistic/blob/master/app/src/main/java/io/github/hidroh/materialistic/accounts/UserServicesClient.java . Two were pushed this week, so [I] it still works; untested.
- Cookie attributes: [U]. Only visible on a real login. Weak hints: Hacki's tests mock `user=hn-session; HttpOnly; Secure` (a mock) https://github.com/Livinglist/Hacki/blob/master/test/utils/hacker_news_fallback_adapter_test.dart ; HN's security page credits a 2021 "Set the SameSite cookie attribute" report without saying it shipped https://news.ycombinator.com/security.html . Assume HttpOnly, and Lax if SameSite is absent in Chromium https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies

## 3. Existing session from another site
- Web page on another origin: no [V]. HN sends no CORS headers (OPTIONS returns 405) and forbids framing (`X-Frame-Options: DENY`, `frame-ancestors 'self'`), checked with curl today. Lax cookies skip cross-site fetch and POST https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie ; Safari and Firefox block or partition third-party cookies by default, Chrome only in Incognito or by setting (MDN link above).
- Chromium extension [V]: "Requests from an extension to a third-party are treated as same-site if the extension has host permissions for the third-party. This means SameSite=Strict cookies can be sent. Note that this only applies to network requests, not access through document.cookie in JavaScript, and does not apply if third-party cookies are blocked." https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies . Fetch from the service worker; content scripts stay under page CORS https://developer.chrome.com/docs/extensions/develop/concepts/network-requests . [I] Use `credentials: 'include'` (default is same-origin) https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials . Firefox and Safari cookie handling on extension requests: [U].
- Page to extension: Chrome/Edge `externally_connectable` + `runtime.sendMessage(extId, ...)` https://developer.chrome.com/docs/extensions/develop/concepts/messaging ; Safari documents it too (ID = bundle ID + team ID) https://developer.apple.com/documentation/safariservices/messaging-between-a-webpage-and-your-safari-web-extension ; Firefox does not https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable . Portable: content script on our origin bridging `window.postMessage`, checking `event.source === window` https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts

## 4. Speech-to-text
- iOS Safari [V]: prefixed `webkitSpeechRecognition` since 14.5; "Siri needs to be enabled"; not in Home Screen web apps or SFSafariViewController https://github.com/Fyrd/caniuse/blob/main/features-json/speech-recognition.json . WebKit uses Apple's SFSpeechRecognizer and forces on-device when the locale supports it https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/speech/cocoa/WebSpeechRecognizerTask.mm . On macOS 26 one test saw no offline mode and a prompt about sending data to Apple https://blog.addpipe.com/apple-speechanalyzer-api/ ; iOS untested [U].
- Chrome Android [V]: partial/prefixed support (caniuse file above); unprefixed `SpeechRecognition` and `processLocally` from Chrome 139 https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json . Audio may go to a server unless `processLocally = true` after `available()`/`install()` https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API , https://developer.chrome.com/blog/new-in-chrome-139 . Android on-device packs actually installing: [U].
- Elsewhere: Firefox 160 (10 Nov 2026) has on-device recognition on desktop only https://www.mozilla.org/en-US/firefox/160.0/releasenotes/ ; Edge's on-device model is Canary/Dev behind a flag https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api ; Brave on-device reports "unavailable" https://github.com/brave/brave-browser/issues/55414
- Fallbacks, ONNX sizes measured from Hugging Face (int8, encoder + merged decoder): whisper-tiny.en about 38 MB, base 73 MB, small 237 MB https://huggingface.co/onnx-community/whisper-tiny.en/tree/main/onnx ; moonshine-tiny 26 MB, base 59 MB https://huggingface.co/onnx-community/moonshine-tiny-ONNX/tree/main/onnx . Moonshine Tiny: "5x reduction in compute requirements for transcribing a 10-second speech segment" vs Whisper tiny-en https://arxiv.org/abs/2410.15608 . Real phone latency: [U], no benchmark run.

## 5. Friction
- CAPTCHA: dang: "we do sometimes turn captchas on for logins when HN is under some kind of (possible) attack" https://news.ycombinator.com/item?id=34313452 ; mobile clients break until HN whitelists the account https://news.ycombinator.com/item?id=34335710 . The page text is "Validation required. If this doesn't work, you can email" plus a g-recaptcha widget (Harmonic source above); HN's CSP allows reCAPTCHA (live headers). A third-party site cannot show it.
- IPs: 403/429/503 for rate-limited IPs https://github.com/Livinglist/Hacki/blob/master/server/README.md ; "your IP address might get banned" https://news.ycombinator.com/newsfaq.html ; crawler accounts ignoring robots.txt were blocked https://news.ycombinator.com/item?id=37759563 . Datacenter-IP logins specifically: no source [U].
- New accounts "are subject to a few extra restrictions" https://news.ycombinator.com/item?id=27229106

## 6. Recommendation: (a) first, (b) optional, (c) no
| Design | Security | Seamless | HN-policy |
|---|---|---|---|
| (a) hand-off | best: no credentials | lowest: copy, open, paste, submit | safest: user posts on HN's own form |
| (b) extension | good: no password, but needs a confirm step inside the extension | high on desktop; none on Chrome Android [I] | moderate: third-party client, human-confirmed |
| (c) server login | worst: we hold passwords or cookies | best on paper | worst: one IP posting for many accounts, against "please don't automate posting" |

Deal-breakers:
- (c): CAPTCHA we cannot present; datacenter-IP rate limits and bans; custody of HN passwords; bot-like traffic.
- (b): third-party cookie blocking (Incognito) disables same-site treatment; Firefox lacks page messaging; Safari needs a packaged app; posting must reconcile before retry (no id returned), or it double-posts.
- (a): no prefill known [U]; the user must be logged in on HN.
