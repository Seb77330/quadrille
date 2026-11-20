# Feuillet

Lecteur et éditeur PDF gratuit qui tourne dans le navigateur et s’installe comme un logiciel. Environ 5 Mo, rien n’est envoyé sur internet.

**Utiliser :** https://seb77330.github.io/quadrille/pdf/

## Installer sur Windows

1. Ouvre le lien ci-dessus dans **Edge**.
2. Clique sur l’icône « Installer l’application » à droite de la barre d’adresse (ou menu ⋯ → Applications → Installer Feuillet).
3. Feuillet apparaît dans le menu Démarrer. Il marche sans internet.
4. Pour ouvrir tes PDF avec Feuillet par défaut : clic droit sur un PDF → Ouvrir avec → Feuillet → « Toujours ».

## Ce qu’il sait faire

- Lire, zoomer, rechercher, imprimer.
- Surligner (sélection de texte ou cadre), stylo, texte, cadre, masquer une zone en blanc, insérer une image.
- Remplir les formulaires PDF, figer un formulaire.
- Signer : dessinée, écrite ou importée ; les signatures sont gardées pour la prochaine fois.
- Pages : fusionner plusieurs PDF, ajouter des images, réordonner (glisser-déposer), pivoter, supprimer, extraire, séparer en fichiers.
- Compresser (pages converties en images JPEG à 150, 100 ou 72 ppp).
- Créer un PDF à partir de photos (une page A4 par image).

## Technique

HTML/CSS/JS sans framework : `index.html` + `app.js`.
Bibliothèques open source embarquées dans `vendor/` : [pdf.js](https://mozilla.github.io/pdf.js/) 6.5 (Apache-2.0) pour l’affichage, [pdf-lib](https://pdf-lib.js.org) 1.17 (MIT) pour l’écriture.
`sw.js` met l’appli en cache pour le mode hors ligne : change `VERSION` à chaque mise à jour.
