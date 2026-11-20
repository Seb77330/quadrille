# Quadrille

Un tableur gratuit qui tourne dans le navigateur et s'installe comme un logiciel.

**Utiliser :** https://seb77330.github.io/quadrille/

## Installer sur Windows

1. Ouvre le lien ci-dessus dans **Edge** ou **Chrome**.
2. Clique sur l'icône « Installer l'application » à droite de la barre d'adresse (ou menu ⋯ → Applications → Installer Quadrille).
3. Quadrille apparaît dans le menu Démarrer et peut être épinglé à la barre des tâches. Il marche sans internet.

## Ce qu'il sait faire

- Formules en français ou en anglais (SOMME/SUM, SI/IF, RECHERCHEV/VLOOKUP, NB.SI, SOMME.SI, ARRONDI…), références entre feuilles.
- Plusieurs feuilles, annuler/rétablir, copier-coller, tri, somme automatique, gras, couleurs, formats € et %.
- Graphiques (barres, courbes, secteurs).
- Ouvre .xlsx, .xls, .ods, .csv ; enregistre en .xlsx et .csv.
- Les données sont gardées automatiquement dans le navigateur.

## Technique

Un seul fichier `index.html` (HTML/CSS/JS sans framework), moteur de formules maison.
Bibliothèques open source embarquées dans `vendor/` : [SheetJS](https://sheetjs.com) (Apache-2.0) pour les fichiers Excel, [Chart.js](https://www.chartjs.org) (MIT) pour les graphiques.
`sw.js` met l'app en cache pour le mode hors ligne : change `VERSION` à chaque mise à jour.
