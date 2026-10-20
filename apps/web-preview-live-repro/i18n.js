/**
 * v0.4.0 — app language (Français / English). Classic script, loaded before every other script.
 *
 * - `I18N.t(fr, vars)` returns the string in the app language. French is the source language: keys are
 *   the French strings, the English column is written for English-speaking collectors (US/UK market
 *   vocabulary), not translated word for word. `{name}` placeholders are interpolated.
 * - Static HTML and the compact app-*.js views are translated at render time: a MutationObserver swaps
 *   any text node / label attribute whose French text is in the dictionary (exact match, or a pattern).
 *   Switching language is live (no reload, the camera keeps running).
 * - Market adaptation: English → TCGplayer (USD) first, en-US number/date formats, English card names
 *   while the printed language is unproven. French → Cardmarket (EUR) first, fr-FR formats.
 */
(function () {
  const LANGS = ['fr', 'en'];
  const pick = () => {
    try { const s = localStorage.getItem('uiLang'); if (LANGS.includes(s)) return s; } catch {}
    return /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en';
  };
  let lang = pick();

  const EN = {
    // ---------------------------------------------------------------- shell, navigation, panels
    'Scanner': 'Scanner', 'Catalogue': 'Search', 'Collection': 'Collection', 'Réglages': 'Settings', 'Fiche': 'Card details',
    'Retour au scanner': 'Back to scanner', 'Retour': 'Back', 'Fermer': 'Close', 'Navigation principale': 'Main navigation',
    'Comment lire le scanner': 'How the scanner works', 'Lire le scanner': 'How the scanner works',
    'Scanner plusieurs cartes à la fois': 'Scan several cards at once', 'Rechercher': 'Search', 'Langue': 'Language',
    'Nom ou numéro, ex. 199/165': 'Name or number, e.g. 199/165', 'Coffret dresseur, display, bundle…': 'Elite Trainer Box, booster box, bundle…',
    'Cartes': 'Cards', 'Produits scellés': 'Sealed', 'Produit scellé': 'Sealed product',
    'Données TCGdex, prix Cardmarket et TCGplayer.': 'Card data from TCGdex · prices from TCGplayer and Cardmarket.',
    'Tapez au moins deux lettres ou un numéro de carte.': 'Type at least two letters or a card number.',
    'Aucune carte trouvée. Essayez le nom exact ou le numéro complet, ex. 199/165.': 'No cards found. Try the exact name or the full number, e.g. 199/165.',
    'Aucune carte avec ce numéro et ce total.': 'No card with that number and set total.',
    'Aucun produit scellé trouvé.': 'No sealed products found.',
    'Aucun produit scellé trouvé. Essayez « coffret dresseur », « display », « booster » ou le nom de l’extension.': 'No sealed products found. Try “Elite Trainer Box”, “booster box”, “booster bundle” or the set name.',
    'Catalogue sealed indisponible': 'Sealed catalog unavailable', 'Catalogue des produits scellés indisponible': 'Sealed catalog unavailable',
    'Recherche impossible': 'Search failed', 'Carte introuvable': 'Card not found',
    'Vider la collection': 'Clear collection', 'Enregistrée sur cet appareil uniquement.': 'Saved on this device only.',
    'Langue des cartes': 'Card language',
    'En automatique, le Lens compare la carte au catalogue français, anglais et japonais, puis lit le texte imprimé pour confirmer la langue. Il n’affiche jamais une langue qu’il n’a pas vérifiée.':
      'In Auto, the scanner compares the card with English, French and Japanese printings, then reads the printed text to confirm the language. It never shows a language it hasn’t verified.',
    'Automatique (recommandé)': 'Auto (recommended)', 'Français uniquement': 'French only', 'Anglais uniquement': 'English only', 'Japonais uniquement': 'Japanese only',
    'Caméra': 'Camera', 'Si l’image reste noire, relancez la caméra arrière.': 'If the picture stays black, restart the rear camera.', 'Relancer la caméra': 'Restart camera',
    'Fiabilité': 'Accuracy',
    'Le Lens ne valide une carte qu’après plusieurs images concordantes et, si besoin, la lecture du numéro imprimé. Sinon il reste en « Identification incertaine » plutôt que de proposer une carte au hasard.':
      'A card is only confirmed after several matching frames and, when needed, a reading of the printed number. Otherwise the scanner says “Not sure yet” instead of guessing.',
    'Codes-barres enregistrés': 'Saved barcodes', 'Effacer les codes-barres enregistrés': 'Clear saved barcodes',
    'Application': 'App', 'Ajouter à l’écran d’accueil': 'Add to Home Screen', 'Confidentialité': 'Privacy',
    'L’image de la caméra reste sur l’appareil. Les prix ne sont chargés qu’une fois la carte identifiée. Volumes et stocks ne sont jamais inventés : s’ils manquent, ils sont marqués « Non disponible ».':
      'The camera feed never leaves your phone. Prices load only once a card is identified. Sales volume and stock are never made up: when missing, they show as “N/A”.',
    'Langue de l’application': 'App language',
    'Textes, formats de prix et source de prix privilégiée (Cardmarket en euros ou TCGplayer en dollars).': 'Text, price formats and preferred price source (TCGplayer in USD or Cardmarket in EUR).',
    'Voyant rouge': 'Red light', 'Aucune carte dans l’image, ou carte non reconnue. Visez une carte, les quatre coins visibles.': 'No card in view, or card not recognized. Point at one card with all four corners visible.',
    'Voyant orange': 'Amber light', 'Analyse en cours : les coins du cadre s’allongent à mesure que les images concordent. Si un conseil s’affiche (reflet, trop loin…), suivez-le.':
      'Analyzing: the corner marks grow as frames agree. If a tip appears (glare, too far…), follow it.',
    'Voyant vert et contour holographique': 'Green light and holo outline', 'Carte identifiée : nom, extension, numéro, langue et prix s’affichent. Touchez la fiche pour le détail.':
      'Card identified: name, set, number, language and price appear. Tap the result for details.',
    'Langue détectée seule': 'Language detected automatically', 'Français, anglais et japonais sont comparés en même temps ; le texte imprimé (PV ou HP, nom, écriture japonaise) confirme la langue avant de valider.':
      'English, French and Japanese printings are compared at once; the printed text (HP, name, Japanese script) confirms the language.',
    '＋ sur le résultat': '＋ on the result',
    'Ajoute la carte à votre collection sans quitter le scanner (touchez plusieurs fois pour plusieurs exemplaires). ✕ ou un glissement vers le bas masque le résultat ; il disparaît aussi quand la carte quitte l’image.':
      'Adds the card to your collection without leaving the scanner (tap again for more copies). ✕ or a swipe down hides the result; it also disappears when the card leaves the frame.',
    'Plusieurs cartes à la fois': 'Several cards at once',
    'Le bouton en haut à gauche scanne jusqu’à 6 cartes posées côte à côte. Une carte n’est nommée que si elle est reconnue sans aucun doute ; sinon elle affiche « ? » : scannez-la seule, la lecture du texte tranchera. « Tout ajouter » met les cartes nommées dans la collection.':
      'The top-left button scans up to 6 cards laid side by side. A card is only named when there is no doubt; otherwise it shows “?” — scan it on its own and the printed text will settle it. “Add all” saves the named cards.',
    'Touchez le voyant': 'Tap the light', 'Il explique ce qu’il se passe. Un appui long affiche le diagnostic technique.': 'It explains what’s happening. Long-press for technical diagnostics.',
    'Le Heat (bêta) n’utilise aujourd’hui que l’évolution des prix ; les ventes et le stock ne sont pas encore disponibles.': 'Heat (beta) currently uses price movement only; sales and stock data aren’t available yet.',
    'Résultats': 'Results', 'OK': 'OK', 'Lens': 'Lens',

    // ---------------------------------------------------------------- scanner HUD
    'français': 'French', 'anglais': 'English', 'japonais': 'Japanese', 'toutes langues': 'all languages',
    'Français': 'French', 'Anglais': 'English', 'Japonais': 'Japanese',
    'Rapprochez la carte': 'Move closer', 'Elle doit occuper au moins un tiers de l’écran.': 'The card should fill at least a third of the screen.',
    'Reculez un peu': 'Move back a little', 'Les quatre coins de la carte doivent rester visibles.': 'Keep all four corners in view.',
    'Centrez la carte': 'Center the card', 'Un coin sort du champ de la caméra.': 'A corner is out of frame.',
    'Mettez la carte à plat': 'Lay the card flat', 'Tenez le téléphone parallèle à la carte.': 'Hold your phone parallel to the card.',
    'Reflet sur la carte': 'Glare on the card', 'Inclinez-la légèrement pour éviter la lumière directe.': 'Tilt it slightly away from direct light.',
    'Trop sombre': 'Too dark', 'Rapprochez-vous d’une source de lumière.': 'Move closer to a light.',
    'Lumière trop forte': 'Too bright', 'Évitez le soleil ou une lampe en plein sur la carte.': 'Avoid direct sun or a lamp right over the card.',
    'Image floue': 'Blurry', 'Tenez le téléphone immobile une seconde.': 'Hold still for a second.',
    'Téléchargement du catalogue visuel ({p} %)': 'Downloading the card catalog ({p}%)',
    'Préparation des cartes de référence ({lang}) : {n} sur {total}': 'Preparing reference cards ({lang}): {n} of {total}',
    'Une réédition quasi identique existe et ne peut pas encore être distinguée. TCG Lens préfère ne pas trancher.': 'A near-identical reprint exists and can’t be told apart yet. TCG Lens won’t guess.',
    'Le texte imprimé contredit l’identification (autre langue). TCG Lens a retiré le résultat plutôt que de se tromper.': 'The printed text contradicts the match (different language). TCG Lens withdrew the result rather than be wrong.',
    'Cette illustration a été rééditée avec le même numéro (ex. Set de Base et Collection Classique). TCG Lens ne peut pas encore distinguer ces éditions et préfère ne pas trancher.':
      'This artwork was reprinted with the same number (e.g. Base Set and Classic Collection). TCG Lens can’t tell these printings apart yet and won’t guess.',
    'Cette illustration existe dans plusieurs éditions : lecture du texte imprimé.': 'This artwork exists in several printings: reading the printed text.',
    'La carte semble être en {lang}, mais cette édition n’existe pas dans cette langue au catalogue. TCG Lens préfère ne pas trancher.': 'The card looks {lang}, but this printing isn’t in the catalog in that language. TCG Lens won’t guess.',
    'Le numéro lu ne correspond pas à l’image. Rendez le bas de la carte bien lisible.': 'The number read doesn’t match the picture. Make the bottom of the card easy to read.',
    'Le numéro lu ne correspond pas à l’image. Vérifiez que la carte est bien en {lang}.': 'The number read doesn’t match the picture. Check that the card is in {lang}.',
    'Cette carte n’est peut-être pas encore chargée. {text}.': 'This card may not be loaded yet. {text}.',
    'Plusieurs cartes se ressemblent. Approchez-vous pour rendre le numéro lisible.': 'Several cards look alike. Move closer so the number is readable.',
    'Approchez-vous pour rendre le numéro en bas de la carte lisible.': 'Move closer so the number at the bottom is readable.',
    'Caméra indisponible': 'Camera unavailable', 'Autorisez l’accès à la caméra dans les réglages du navigateur, puis réessayez.': 'Allow camera access in your browser settings, then try again.', 'Réessayer': 'Try again',
    'Touchez l’écran': 'Tap the screen', 'Le navigateur attend un geste pour lancer la caméra (mode économie d’énergie).': 'Your browser needs a tap to start the camera (Low Power Mode).',
    'Activation de la caméra': 'Starting camera', 'Autorisez l’accès à la caméra si le navigateur le demande.': 'Allow camera access if your browser asks.',
    'Carte identifiée': 'Card identified', 'Nouvelle carte ?': 'New card?', 'Gardez-la en place quelques instants pour confirmer.': 'Hold it there a moment to confirm.',
    'Placez une carte dans le cadre': 'Point at a card', 'Une seule carte, face visible, sur un fond uni.': 'One card, face up, on a plain background.',
    'Carte repérée': 'Card found', 'Ne bougez plus.': 'Hold still.',
    'Cartes de référence en préparation': 'Preparing reference cards', '{text}. La reconnaissance s’améliore à mesure.': '{text}. Recognition improves as it loads.',
    'Carte non reconnue': 'Card not recognized', 'Cette carte n’est pas encore au catalogue, ou l’image est trop différente. Essayez sous un autre angle.': 'This card isn’t in the catalog yet, or the picture is too different. Try another angle.',
    'Vérifiez que la langue de scan correspond à la carte ({lang}).': 'Check that the scan language matches the card ({lang}).',
    'Identification incertaine': 'Not sure yet', 'Numéro illisible': 'Can’t read the number',
    'Approchez le téléphone du bas de la carte : le numéro (par exemple 001/084) doit être net et sans reflet.': 'Bring your phone closer to the bottom of the card: the number (e.g. 001/084) must be sharp, with no glare.',
    'Lecture de la langue': 'Reading the language', 'Cette carte existe en plusieurs langues : gardez le texte de la carte lisible.': 'This card exists in several languages: keep its text readable.',
    'Lecture du numéro': 'Reading the number', 'Le numéro imprimé en bas de la carte confirme l’édition exacte.': 'The number printed at the bottom confirms the exact printing.',
    'Comparaison avec le catalogue': 'Matching against the catalog', 'Quelques secondes.': 'A few seconds.',
    'Envoyer un diagnostic': 'Send diagnostics', 'Partager le diagnostic': 'Share diagnostics', 'Produit reconnu par code-barres': 'Product recognized from barcode',
    'Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, puis réessayez.': 'Camera access denied. Allow it in your browser settings, then try again.',
    'Aucune caméra arrière détectée sur cet appareil.': 'No rear camera found on this device.',
    'La caméra est utilisée par une autre application. Fermez-la, puis réessayez.': 'Another app is using the camera. Close it, then try again.',
    'La caméra nécessite une connexion sécurisée (HTTPS).': 'The camera requires a secure (HTTPS) connection.',
    'La caméra n’a pas pu démarrer. Réessayez.': 'The camera couldn’t start. Try again.',

    // ---------------------------------------------------------------- result sheet, card details, market
    'Est-ce cette carte ?': 'Is this your card?', 'Aucune de ces cartes': 'None of these', 'Numéro concordant': 'Number matches', 'Très probable': 'Very likely', 'Probable': 'Likely',
    'Déjà confirmée par vous': 'You confirmed it before', 'Même illustration': 'Same artwork', 'Confirmée par vous': 'Confirmed by you',
    'Masquer le résultat': 'Hide result', 'Prix n.d.': 'No price', 'Extension inconnue': 'Unknown set', 'Langue ?': 'Language?', 'Carte': 'Card',
    'dès {price}': 'from {price}', 'Ajouter {name} à la collection': 'Add {name} to collection', 'Ouvrir la fiche de {name}': 'Open {name}',
    'En hausse': 'Rising', 'En baisse': 'Falling', 'Stable': 'Stable', 'Tendance inconnue': 'Trend unknown',
    'Froid': 'Cold', 'Frais': 'Cool', 'Tiède': 'Warm', 'Chaud': 'Hot', 'En flambée': 'Surging',
    'Heat non disponible': 'Heat N/A', 'Heat indisponible': 'Heat N/A', 'Heat bêta': 'Heat (beta)', 'Fiabilité du Heat': 'Heat confidence',
    'Faible': 'Low', 'Moyenne': 'Medium', 'Élevée': 'High', 'Non disponible': 'N/A', 'ventes et stock non disponibles': 'sales and stock N/A',
    'Rareté': 'Rarity', 'Illustrateur': 'Illustrator', 'Image non disponible': 'No image', 'Set inconnu': 'Unknown set',
    'Prix non disponible': 'No price available', 'Fourchette non disponible': 'Price range N/A', 'Aucune source de prix pour cette carte pour le moment.': 'No price source for this card yet.',
    'Aperçu': 'Overview', 'Marché': 'Market', 'Sources': 'Sources', 'Identité et image': 'Identity and image', 'Ajouter à la collection': 'Add to collection', '+ Ajouter à la collection': '+ Add to collection',
    'Le Heat bêta ne mesure pour l’instant que l’évolution du prix. Les ventes, le taux d’écoulement et le stock ne sont pas encore disponibles et ne sont jamais estimés.':
      'Heat (beta) only measures price movement for now. Sales, sell-through and stock aren’t available yet and are never estimated.',
    'Moyenne 1 jour': '1-day average', 'Moyenne 7 jours': '7-day average', 'Moyenne 30 jours': '30-day average', 'Cardmarket, tendance': 'Cardmarket trend',
    'Prix Cardmarket': 'Cardmarket prices', 'Moyennes, plus bas, tendance (EUR)': 'Averages, low, trend (EUR)', 'Prix en euros': 'Prices in EUR',
    'Historique insuffisant': 'Not enough history', 'Aucune donnée marché disponible.': 'No market data available.', 'Prix non disponible pour ce produit.': 'No price available for this product.',
    'scan optionnel': 'optional scan', 'non lié': 'not linked', 'prêt à associer': 'ready to link', 'scellé': 'sealed', 'Produit': 'Product',
    'Associer ce barcode à ce produit': 'Link this barcode to this product',
    'Aucun code associé': 'No barcode linked', 'reconnu sur cet appareil': 'recognized on this device', 'scannez la boîte pour l’associer': 'scan the box to link it',
    'Code-barres associé : il sera reconnu immédiatement': 'Barcode linked: it will be recognized instantly',
    'Code-barres reconnu': 'Barcode recognized', 'Code-barres lu': 'Barcode read', 'Autre produit': 'Different product', 'C’est bien ce produit': 'That’s the one',
    'Ce code n’est pas encore dans les bases publiques.': 'This barcode isn’t in public databases yet.', 'Quel produit ?': 'Which product?',
    'Nom du produit à associer au code-barres': 'Product name to link to this barcode',
    'Coffret Dresseur d’Élite': 'Elite Trainer Box', 'Display': 'Booster Box', 'Booster': 'Booster pack', 'Coffret': 'Collection box', 'Tripack': '3-pack blister', 'Blister': 'Blister',
    'Boîte métal': 'Tin', 'Deck': 'Deck', 'Bundle': 'Booster bundle', 'Coffret Premium': 'Premium collection', 'Mini-tin': 'Mini tin', 'Autre produit scellé': 'Other sealed product',

    // ---------------------------------------------------------------- collection
    'Ajouté à la collection': 'Added to collection', 'Retiré de la collection': 'Removed from collection', 'Collection vidée': 'Collection cleared',
    'La collection est déjà vide': 'Your collection is already empty', 'Vider la collection ?': 'Clear collection?',
    'Toutes les cartes enregistrées sur cet appareil seront retirées.': 'Every card saved on this device will be removed.', 'Annuler': 'Cancel', 'Vider': 'Clear',
    'Votre collection est vide.': 'Your collection is empty.', 'Cartes et produits': 'Cards & products', 'Valeur estimée': 'Estimated value', '{n} sans prix': '{n} without a price',
    'Plus récents': 'Recently added', 'Valeur': 'Value', 'Nom': 'Name', 'Extension': 'Set',
    'Actualiser les prix': 'Refresh prices', 'Actualisation…': 'Refreshing…', 'Exporter (CSV)': 'Export (CSV)', 'Trier': 'Sort', 'Quantité': 'Quantity',
    'Retirer un exemplaire': 'Remove one copy', 'Ajouter un exemplaire': 'Add one copy', 'Aucun prix à actualiser': 'No prices to refresh',
    'Codes-barres effacés': 'Barcodes cleared', 'Aucun code-barres enregistré sur cet appareil.': 'No barcodes saved on this device.', '1 code-barres enregistré sur cet appareil.': '1 barcode saved on this device.',
    'Sans image': 'No image',

    // ---------------------------------------------------------------- multi-card, barcodes, install
    'Mode plusieurs cartes': 'Multi-card mode', 'Mode une carte': 'Single-card mode', 'Mode plusieurs cartes indisponible sur cet appareil': 'Multi-card mode isn’t available on this device',
    'À scanner seule': 'Scan on its own', 'Tout ajouter': 'Add all',
    'Barcode détecté': 'Barcode detected', 'Barcode reconnu localement': 'Barcode recognized on this device', 'Barcode': 'Barcode', 'Scanner un barcode': 'Scan a barcode',
    'Montre le code au centre': 'Center the barcode', 'Nom du produit pour associer le barcode…': 'Product name to link the barcode…', 'Recherche barcode…': 'Looking up barcode…',
    'Rechercher le produit': 'Find the product', 'Barcode associé localement': 'Barcode linked on this device', 'Code trop court': 'Code too short',
    'Astuce iPhone : Partager → Sur l’écran d’accueil pour une expérience plein écran.': 'iPhone tip: Share → Add to Home Screen for a full-screen app.',
    'Installation disponible depuis le menu du navigateur': 'Install from your browser menu', 'Partager → Sur l’écran d’accueil': 'Share → Add to Home Screen',
    'Diagnostic TCG Lens': 'TCG Lens diagnostics', 'Candidats :': 'Candidates:',
    'Produit non reconnu': 'Product not recognized', 'Bundle de boosters': 'Booster bundle', 'Pokébox (tin)': 'Tin', 'Coffret collection': 'Collection box', 'Carton': 'Case', 'Autre produit': 'Other product',
    'Allemand': 'German', 'Base publique': 'Public database', 'Espagnol': 'Spanish', 'Italien': 'Italian', 'Code-barres': 'Barcode', 'bêta': 'beta',
    'Langue de l’application': 'App language', 'Français ': 'Français ',
  };

  // Interpolated strings rendered by the compact views (exact text after the fact).
  const PATTERNS = [
    [/^(\d+) cartes? trouvées?\.$/, (m, n) => `${n} card${n === '1' ? '' : 's'} found.`],
    [/^(\d+) cartes trouvées, 60 premières affichées\. Précisez le nom ou ajoutez le numéro\.$/, (m, n) => `${n} cards found, showing the first 60. Refine the name or add the number.`],
    [/^(\d+) cartes? avec ce numéro\.$/, (m, n) => `${n} card${n === '1' ? '' : 's'} with this number.`],
    [/^(\d+) codes-barres enregistrés sur cet appareil\.$/, (m, n) => `${n} barcodes saved on this device.`],
    [/^(.*), n° (\S+) \((Français|Anglais|Japonais|FR|EN|JA)\)$/, (m, set, n, l) => `${set} · #${n} (${EN[l] || l})`],
    [/^(.*), n° (\S+), (français|anglais|japonais)$/, (m, set, n, l) => `${set} · #${n} · ${EN[l]}`],
    [/^n° (\S+)/, (m, n) => `#${n}`],
    [/^Code-barres (\S+) · recherche du produit…$/, (m, c) => `Barcode ${c} · looking up the product…`],
    [/^Associer le code (\S+) à ce produit$/, (m, c) => `Link barcode ${c} to this product`],
    [/^tendance (.+)$/, (m, s) => `${s} trend`],
    [/^Ajouté à la collection \(×(\d+)\)$/, (m, n) => `Added to collection (×${n})`],
    [/^(\d+) prix actualisés?$/, (m, n) => `${n} price${n === '1' ? '' : 's'} refreshed`],
    [/^(\d+) produits? · prix Cardmarket et TCGplayer\.$/, (m, n) => `${n} product${n === '1' ? '' : 's'} · TCGplayer and Cardmarket prices.`],
    [/^Code-barres (\S+)$/, (m, c) => `Barcode ${c}`],
    [/^(.*), mis à jour le (.+)$/, (m, a, d) => `${EN[a] || a} · updated ${d}`],
    [/^Produit scellé, Cardmarket n° (\S+)$/, (m, id) => `Sealed product · Cardmarket #${id}`],
  ];

  const interpolate = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);
  function t(fr, vars) {
    const s = lang === 'en' ? (EN[fr] ?? fr) : fr;
    return interpolate(s, vars);
  }
  function translateText(fr) {
    if (lang !== 'en') return null;
    const trimmed = fr.trim(); if (!trimmed) return null;
    if (EN[trimmed] != null) return fr.replace(trimmed, EN[trimmed]);
    for (const [re, fn] of PATTERNS) { const m = trimmed.match(re); if (m) return fr.replace(trimmed, fn(...m)); }
    return null;
  }

  // ------------------------------------------------------------------ DOM translation (render time)
  const ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];
  const origText = new WeakMap(), origAttr = new WeakMap();
  let applying = false;
  function translateNode(node) {
    if (node.nodeType === 3) {
      const cur = node.nodeValue;
      const known = origText.get(node);
      const src = known && known.out === cur ? known.src : cur; // text changed by the app → new source
      const out = lang === 'en' ? translateText(src) : null;
      if (out != null) { origText.set(node, { src, out }); if (cur !== out) node.nodeValue = out; }
      else if (known && known.out === cur && lang !== 'en') { node.nodeValue = known.src; origText.delete(node); }
      return;
    }
    if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.getAttribute('translate') === 'no') return;
    let saved = origAttr.get(node);
    for (const a of ATTRS) {
      if (!node.hasAttribute(a)) continue;
      const cur = node.getAttribute(a);
      const prev = saved?.[a];
      const src = prev && prev.out === cur ? prev.src : cur;
      const out = lang === 'en' ? translateText(src) : null;
      if (out != null) { saved = saved || {}; saved[a] = { src, out }; origAttr.set(node, saved); if (cur !== out) node.setAttribute(a, out); }
      else if (prev && prev.out === cur && lang !== 'en') node.setAttribute(a, prev.src);
    }
    for (let c = node.firstChild; c; c = c.nextSibling) translateNode(c);
  }
  function translateAll() { applying = true; try { translateNode(document.body); } finally { applying = false; } }
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(list => {
    if (applying || lang !== 'en') return;
    applying = true;
    try {
      for (const m of list) {
        if (m.type === 'characterData') translateNode(m.target);
        else if (m.type === 'attributes') translateNode(m.target);
        else m.addedNodes.forEach(translateNode);
      }
    } finally { applying = false; }
  }) : null;

  function syncControls() {
    document.querySelectorAll('[data-uilang]').forEach(b => { const on = b.dataset.uilang === lang; b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); });
    // Catalogue search: cards in the app language by default (the user can still pick FR / EN / JA).
    const sel = document.getElementById('langSelect');
    if (sel && !sel.dataset.userSet && (sel.value === 'fr' || sel.value === 'en')) sel.value = lang;
  }
  function startObserver() {
    observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    translateAll(); syncControls();
    document.addEventListener('click', e => { const b = e.target.closest?.('[data-uilang]'); if (b) setLang(b.dataset.uilang); });
    document.getElementById('langSelect')?.addEventListener('change', e => { e.target.dataset.userSet = '1'; });
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    lang = next;
    try { localStorage.setItem('uiLang', lang); } catch {}
    document.documentElement.lang = lang;
    translateAll(); syncControls();
    document.dispatchEvent(new CustomEvent('tcglens:uilang', { detail: { lang } }));
  }

  const locale = () => (lang === 'en' ? 'en-US' : 'fr-FR');
  function money(v, currency = 'EUR') {
    if (v == null || !Number.isFinite(Number(v))) return null;
    try { return new Intl.NumberFormat(locale(), { style: 'currency', currency, maximumFractionDigits: Number(v) >= 100 ? 0 : 2 }).format(Number(v)); }
    catch { return `${Number(v).toFixed(2)} ${currency}`; }
  }
  const number = v => new Intl.NumberFormat(locale()).format(v);
  const date = (d, opts) => new Date(d).toLocaleDateString(locale(), opts);
  /** Preferred market: TCGplayer (USD) for English, Cardmarket (EUR) for French. */
  const market = () => (lang === 'en' ? 'us' : 'eu');

  document.documentElement.lang = lang;
  globalThis.I18N = { get lang() { return lang; }, LANGS, t, setLang, money, number, date, locale, market, translateText, translateAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true }); else startObserver();
})();
