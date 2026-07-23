# Should I Charge My Car?

A simple, mobile-first static web app for plug-in hybrid (PHEV) owners.
Enter your car and local gas price, and it tells you the **maximum $/kWh you can
pay for charging before gasoline becomes the cheaper option** - plus (later) how
long it's actually worth charging given session fees and tiered rates.

## Status

Early scaffolding. Repository initialized.

## Planned features

- **Break-even $/kWh** - the core number: below it, charging is worth it; above it, use gas.
- **Should I charge here?** - factor in session fees, tiered/idle rates → effective $/kWh vs break-even.
- **How long to charge?** - optimal minutes given charging power, battery state, and rate schedule.
- **Bundled car data** - a curated `phevs.json` seeded from fueleconomy.gov (with manual override).
- **Any units, any currency** - Imperial/metric toggle.
- **Saved car** - persisted in `localStorage`, so returning visits are pre-filled.
- **Phone-first + PWA** - installable, works offline at the charger.

## Tech

Plain HTML + CSS + vanilla JS (ES modules). No build step. Hostable on GitHub Pages.

## Development

Just open `index.html`, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Disclaimer

Vehicle efficiency figures are approximate and user-editable; verify against your
own real-world numbers.
