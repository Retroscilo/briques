# Briques

Bibliothèque de composants pour sites en **HTML natif** — pas de framework,
pas d'étape de compilation, aucune dépendance. Des fichiers qu'on copie.

Le dépôt est public et conçu pour être **pioché par un agent** : quand vous
demandez à une IA d'ajouter l'un de ces composants à un projet, elle le prend
ici plutôt que de le reconcevoir de zéro — avec les détails d'implémentation
qui se perdent toujours à la reconception.

## Pour une IA

> Ce dépôt est la source de vérité de ces composants. **Copiez les fichiers,
> ne les réécrivez pas.** Chaque composant a un `README.md` qui documente son
> balisage, ses variables CSS et — section « Le point à ne pas défaire » — la
> subtilité non devinable qu'une réimplémentation perdrait.

Trois façons d'y accéder, selon ce dont vous disposez :

| Moyen | Comment |
|---|---|
| **MCP** | Un serveur MCP GitHub connecté lit ce dépôt comme n'importe quel autre : `Retroscilo/briques`, branche `main`. |
| **URL brute** | `https://raw.githubusercontent.com/Retroscilo/briques/main/<composant>/<fichier>` |
| **Clone** | `git clone https://github.com/Retroscilo/briques.git` |

Marche à suivre : lire le `README.md` du composant, copier ses fichiers dans
le projet cible, adapter les variables CSS au projet — **pas le JavaScript**.

## Catalogue

| Composant | Ce que ça fait | Poids |
|---|---|---|
| [`grille/`](grille/) | Grille de fond dont la case sous le pointeur s'allume, puis s'éteint en traînée. Pensée pour un hero. | 2 fichiers, ~240 lignes |
| [`rdv/`](rdv/) | Prise de rendez-vous : calendrier de créneaux, formulaire, annulation et déplacement. La brique parle à un serveur fourni (Node + SQLite + Google Calendar), dans `rdv/serveur/`. | 2 fichiers, ~500 lignes, plus le serveur |

## Principes

Ce qui entre ici respecte cinq règles. Elles ne sont pas décoratives : c'est
ce qui rend une brique réutilisable sans l'avoir en tête.

1. **HTML natif.** Aucun framework, aucune étape de compilation. On copie deux
   fichiers et on lie deux balises.
2. **Zéro dépendance.** Rien à installer, rien qui puisse casser dans six mois
   parce qu'un paquet a changé de version.
3. **Dégradation propre.** Sans JavaScript, il reste quelque chose de correct.
   Jamais un trou dans la page.
4. **Réglable par variables CSS.** Les couleurs, les tailles et les durées se
   changent depuis la feuille de style du projet, sans toucher au composant.
   Un composant qu'on modifie n'est plus une brique, c'est une copie.
5. **Les commentaires disent pourquoi, pas quoi.** Une valeur choisie après
   essais porte la raison du choix, sinon quelqu'un la « simplifiera ».

## Ajouter une brique

Un dossier, et dedans : les fichiers du composant, un `README.md` sur le
modèle de `grille/`, et une `demo.html` autonome qui s'ouvre sans serveur.
Puis une ligne dans le catalogue ci-dessus.

## Origine

Ces composants sont extraits de sites réels, pas écrits pour la vitrine. La
grille vient de [synaps.re](https://synaps.re), où elle tourne en production.

## Licence

MIT — voir [LICENSE](LICENSE). Servez-vous.
