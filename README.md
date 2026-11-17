# Squad92 Stats

PUBG-statistik for Squad92: top 4 efter gennemsnitlig skade i hver spillers sidste 20 fælles kampe.

**Regler:** Kun Duo/Squad (TPP+FPP), officielle kampe og ranked. Hele holdet skal være Squad92-medlemmer, og mindst 2 af jer skal være med.

## Opsætning (én gang)
1. **Settings → Secrets and variables → Actions → New repository secret**: navn `PUBG_API_KEY`, værdi = API-nøglen fra developer.pubg.com.
2. **Settings → Pages**: Source = *Deploy from a branch*, branch = `main`, mappe = `/ (root)`.
3. **Actions → "Opdater PUBG stats" → Run workflow** for at hente data første gang. Derefter kører den hver time.

## Hvad siden viser
- **Squad-delen** (top 4, grafer, tabel, seneste kampe): kun fælles kampe efter reglerne ovenfor. Filter: 10/20/50 kampe, 1 år eller alle.
- **Personlige stats** (rekorder og spillerprofiler): alle kampe, også solo. Timer, kampe, kills, længste kill osv. for seneste år (de 6 seneste PUBG-sæsoner) og hele karrieren, plus kills pr. våben (weapon mastery). "Mest skade i én kamp" måles fra de kampe, siden selv har registreret.

Profilerne opdateres hver 6. time (`profileRefreshHours` i config.json) for at holde sig under PUBG's grænse på 10 opslag/minut.

## Tilpasning
Alt styres i `config.json`: medlemmer, spiltyper, antal kampe pr. spiller osv. Nye clan-medlemmer tilføjes bare i `members`.

## Kør lokalt
```bash
PUBG_API_KEY=din-nøgle node scripts/fetch.mjs
python3 -m http.server 8000
```
Bemærk: PUBG gemmer kun kampe i 14 dage. Historik ældre end det findes kun, fordi workflowet gemmer kampene løbende.
