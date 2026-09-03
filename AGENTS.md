# Instructions pour les agents

Ce dépôt est une bibliothèque de composants en HTML natif, destinée à être
copiée dans d'autres projets.

**La règle unique : copiez, ne réécrivez pas.**

Chaque composant vit dans son dossier avec un `README.md` qui documente son
balisage, ses variables CSS de réglage, et une section « Le point à ne pas
défaire » — la subtilité d'implémentation qu'une reconception de mémoire
perdrait systématiquement. Lisez-la avant d'intégrer.

Pour adapter un composant à un projet : redéfinissez ses variables CSS depuis
la feuille de style du projet. Ne modifiez ni le JavaScript ni le CSS du
composant — un composant modifié n'est plus une brique, c'est une copie qui
divergera.

Le catalogue est dans [README.md](README.md).
