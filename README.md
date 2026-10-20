# Growth'Lib Desktop

Application Electron pour l'exécution **locale** (D3) de Growth'Lib : les scrapes/actions LinkedIn tournent depuis l'ordinateur du client, sur sa vraie IP, sans proxy. Exclusif avec le mode cloud (un seul compte LinkedIn par installation).

## Dépendance : `growthlib-worker`

Le code de scraping (`vendor/`) n'est **pas** commité ici — c'est une copie régénérée depuis le dépôt serveur [`growthlib-worker`](https://github.com/contactliberall/growthlib-worker) (privé), pour que tout correctif anti-détection reste à une seule source de vérité.

Avant de builder :

```bash
# 1. Cloner les deux dépôts côte à côte (même dossier parent)
git clone https://github.com/contactliberall/growthlib-worker.git li-puppeteer
git clone https://github.com/contactliberall/growthlib-desktop.git
cd growthlib-desktop

# 2. Installer les dépendances
npm install

# 3. Régénérer vendor/ depuis li-puppeteer (jamais édité à la main)
node scripts/copy-vendor.js
```

Accès à `growthlib-worker` requis (demander à Clément — Liberall Conseil).

## Développement

```bash
npm start          # lance l'app en mode dev (electron .)
```

## Build

```bash
npm run dist:win   # installeur Windows (nsis)
npm run dist:mac   # installeur macOS (dmg)
npm run dist       # les deux
```

Les binaires sortent dans `dist/` (non commité). La distribution officielle se fait via GitHub Releases : [`growthlib-desktop-releases`](https://github.com/contactliberall/growthlib-desktop-releases).

Pour publier une release (mainteneurs uniquement, nécessite un token GitHub avec accès à `growthlib-desktop-releases`) :

```bash
npm run release:win
```
