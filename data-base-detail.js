import puppeteer from 'puppeteer';
import { createObjectCsvWriter } from 'csv-writer';
import readlineSync from 'readline-sync';

const SELECTORS = {
    filmItem: '.card.entity-card-simple.userprofile-entity-card-simple',
    filmTitle: '.meta-title.meta-title-link',
    nextPage: '.button.button-md.button-primary-full.button-right',
    popupAcceptCookies: '.jad_cmp_paywall_button'
};

function getFullFilmUrl(relativeUrl) {
    return relativeUrl.startsWith('http') ? relativeUrl : `https://www.allocine.fr${relativeUrl}`;
}

// Scrape liste de films (titre, url, rating)
async function scrapeAllFilms(page, profileUrl, maxPages = 17) {
    let films = [];

    for (let i = 1; i <= maxPages; i++) {
        const url = `${profileUrl}?page=${i}`;
        console.log(`Scraping page: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        if (await page.$(SELECTORS.popupAcceptCookies)) {
            await page.click(SELECTORS.popupAcceptCookies);
            await page.waitForTimeout(600);
        }

        const pageFilms = await page.$$eval(SELECTORS.filmItem, els =>
            els.map(el => {
                const linkEl = el.querySelector('.meta-title.meta-title-link');
                const title = linkEl?.title?.trim() ?? "";
                const href = linkEl?.getAttribute('href') ?? "";
                let rating = "";
                const mdl = el.querySelector('.rating-mdl');
                if (mdl) {
                    const match = mdl.className.match(/n(\d{2})/);
                    if (match) rating = `${match[1][0]}.${match[1][1]}`;
                }
                return { title, rating, url: href };
            })
        );

        if (pageFilms.length === 0) break;

        films = films.concat(pageFilms);
    }
    return films;
}

// Scraper durée et réalisateurs sur la page du film
async function scrapeFilmDetails(page, filmUrl) {
    try {
        await page.goto(filmUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Durée : récupère un texte commençant par "Xh"
        const duration = await page.evaluate(() => {
            const meta = document.querySelector('.meta-body-info');
            if (!meta) return '';
            const textNodes = Array.from(meta.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
            for (const node of textNodes) {
                const trimmed = node.textContent.trim();
                if (/^\d+h/.test(trimmed)) return trimmed;
            }
            return '';
        });

        // Réalisateurs : liens spécifiques avec href contenant "personne/fichepersonne_gen_cpersonne="
        const directors = await page.$$eval(
            'a.xXx.dark-grey-link[href*="/personne/fichepersonne_gen_cpersonne="]',
            els => els.map(el => el.textContent.trim()).join(', ')
        );

        return { duration, directors };
    } catch (e) {
        console.error(`Erreur scraping ${filmUrl}:`, e);
        return { duration: '', directors: '' };
    }
}

// Export CSV
async function exportToCsv(filename, headers, data) {
    const csvWriter = createObjectCsvWriter({
        path: filename,
        header: headers.map(h => ({ id: h, title: h })),
        alwaysQuote: true
    });
    await csvWriter.writeRecords(data);
}

// Validation URL
function isValidAllocineProfileUrl(url) {
    return /^https:\/\/www\.allocine\.fr\/membre-\w+\/films\/?$/i.test(url);
}

(async () => {
    const url = readlineSync.question('\nCopie-colle ici le lien de ton profil Allociné (format : https://www.allocine.fr/membre-.../films/) :\n> ');
    if (!isValidAllocineProfileUrl(url)) {
        console.error('❌ Lien Allociné invalide !');
        process.exit(1);
    }

    console.log('⏳ Scraping en cours...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();

    try {
        const films = await scrapeAllFilms(page, url);
        console.log(`🎬 ${films.length} films extraits.`);

        // Pour chaque film, on scrape les détails durée et réalisateurs
        for (let i = 0; i < films.length; i++) {
            const film = films[i];
            const fullUrl = getFullFilmUrl(film.url);
            const details = await scrapeFilmDetails(page, fullUrl);
            films[i] = {
                Title: film.title,
                Rating: film.rating,
                Url: fullUrl,
                Duration: details.duration,
                Directors: details.directors
            };
            console.log(`→ [${i + 1}/${films.length}] ${film.title} | Durée: ${details.duration} | Réalisateur(s): ${details.directors}`);
        }

        await exportToCsv('allocine-films-details.csv', ['Title', 'Rating', 'Duration', 'Directors', 'Url'], films);
        console.log('✅ Export terminé dans : allocine-films-details.csv');

    } catch (err) {
        console.error('❌ Erreur:', err);
    } finally {
        await browser.close();
        console.log('🎉 Terminé !');
    }
})();
