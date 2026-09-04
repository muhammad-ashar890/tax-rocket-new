# Tax Rocket Portal Agent — Windows installer

Assisted Filing local Electron pe kaam kar chuka hai. Ab Windows `.exe` setup yahan se banta hai.

**Code signing cert nahi chahiye** is dev build ke liye. SmartScreen pehle run pe warning de sakta hai — *More info → Run anyway*.

## Windows pe build

Pehle `npm run dev` / Electron **band** karo (file lock se build fail ho sakti hai).

```bat
cd path\to\tax-rocket\electron-connect
npm install
npm run dist:win
```

Pehli dafa Electron + NSIS binaries download hongi (100MB+). 2–5 minute lag sakte hain.

## Output

```
electron-connect\dist\TaxRocket-Portal-Agent-Setup-1.0.0.exe
```

Is `.exe` ko double-click karke install karo:

- Desktop + Start Menu shortcut: **Tax Rocket Portal Agent**
- Deep link: `taxrocket-connect://`

## Install ke baad test

1. Start Menu se **Tax Rocket Portal Agent** kholo (ab `npx electron` ki zaroorat nahi).
2. Web app (`npm run dev`) mein Create Desktop Session → Open Desktop App.
3. Queue Assisted Filing — wahi pause flow: Password Reset → OTP → PSID → Final Review → Completed.

Dev mode (`npx electron . --dev`) ab bhi kaam karega. Installer packaged app hai.

## Dashboard Download button

Build ke baad `/api/downloads/taxrocket-agent/windows` local `.exe` serve karega, jab file `electron-connect/dist/` mein ho.

## Fail ho to

- `icon.ico missing` → `electron-connect/assets/icon.ico` copy hua ya nahi check karo.
- `electron-builder` not found → `electron-connect` ke andar `npm install`.
- NSIS / 7zip error → Windows 10/11 x64, antivirus ko `dist` folder skip.
- Build Linux/Mac se Windows `.exe` ke liye wine chahiye — **Windows machine pe hi chalao**.
