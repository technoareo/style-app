# Style Studio
A responsive everyday outfit-styling app. Build a personal clothing collection, add outfit photos, save a daily look, and personalize your style experience.
Features
- Responsive, editorial-inspired dashboard and mobile navigation
- Email-based demo registration/sign-in and local profile persistence
- Add clothing photos from a device; wardrobe and images persist in browser local storage
- Daily outfit recommendation from wardrobe pieces, with styling rationale
- Save/unsave a look and browse your wardrobe and saved looks
- Optional personal photo upload

## Run locally
Requires Node.js 18+.
\n\n```bash\nnpm install\nnpm run dev\n```\nOpen http://localhost:3000. 

To create a production build: `npm run build`. 

Current implementation and production work\nThis initial version is a working front-end demo. It does not yet provide production authentication, cloud image storage, weather-aware styling, or a remote AI inference service. Sign-in is a local demo and wardrobe photos are kept in the current browser. Before production, add a secure auth provider and database/storage service, implement server-side wardrobe APIs, and connect an AI vision/styling provider with consent, retention, and deletion controls for personal photos.
