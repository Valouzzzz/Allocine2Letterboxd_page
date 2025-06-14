import puppeteer from 'puppeteer';
import { createObjectCsvWriter } from 'csv-writer';
import readlineSync from 'readline-sync';

const SELECTORS = {
    filmItem: '.card.entity-card-simple.userprofile-entity-card-simple',
    filmTitle: '.meta-title.meta-title-link',
    filmRating: '.rating-mdl',
    tabReview: 'span.roller-item[title="Critiques"]',
    filmReviewBlock: '.review-card',
    filmReview: '.content-txt.review-card-content',
    filmReviewLirePlus: '.blue-link.link-more',
    filmTitleOnReview: 'a.xXx',
    nextPage: '.button.button-md.button-primary-full.button-right',
    popupAcceptCookies: '.jad_cmp_paywall_button'
};

function getFullFilmUrl(relativeUrl) {
    return relativeUrl.startsWith('http') ? relativeUrl : `https://www.allocine.fr${relativeUrl}`;
}

async function gotoTabCritiques(page, url) {
    const reviewUrl = url.replace(/\/films\/?$/, '/critiques/films/');
    await page.goto(reviewUrl, { waitUntil: 'networkidle2' });
    if (await page.$(SELECTORS.popupAcceptCookies)) {
        await page.click(SELECTORS.popupAcceptCookies);
        await page.waitForTimeout(600);
    }
    await page.waitForSelector(SELECTORS.filmReviewBlock, { timeout: 8000 });
}

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

async function scrapeAllReviews(page, profileUrl) {
    const reviews = [];
    await gotoTabCritiques(page, profileUrl);
    let pageNb = 1;
    const seenFirstReviews = new Set();

    while (true) {
        await page.waitForSelector(SELECTORS.filmReviewBlock, { timeout: 4000 }).catch(() => {});

        const pageReviews = await page.$$eval(SELECTORS.filmReviewBlock, blocks =>
            blocks.map(block => {
                let filmTitle = "";
                let reviewText = "";
                let hasLirePlus = false;
                let moreUrl = "";

                try {
                    const titleEl = block.querySelector('.review-card-title a.xXx');
                    filmTitle = titleEl ? titleEl.textContent.trim() : '';
                } catch (e) {}

                try {
                    const reviewEl = block.querySelector('.content-txt.review-card-content');
                    reviewText = reviewEl ? reviewEl.textContent.trim() : '';
                } catch (e) {}

                try {
                    const lirePlusEl = block.querySelector('.blue-link.link-more');
                    if (lirePlusEl) {
                        hasLirePlus = true;
                        moreUrl = lirePlusEl.href;
                    }
                } catch (e) {}

                return {
                    filmTitle,
                    reviewText,
                    hasLirePlus,
                    moreUrl
                };
            })
        );

        if (pageReviews.length === 0) break;

        let firstKey = pageReviews[0].reviewText;
        if (firstKey && seenFirstReviews.has(firstKey)) break;
        if (firstKey) seenFirstReviews.add(firstKey);

        for (let reviewData of pageReviews) {
            let { filmTitle, reviewText, hasLirePlus, moreUrl } = reviewData;

            if (hasLirePlus && moreUrl) {
                try {
                    await page.goto(moreUrl, { waitUntil: 'domcontentloaded' });
                    await page.waitForSelector(SELECTORS.filmReview, { timeout: 2500 }).catch(() => {});
                    reviewText = await page.$eval(SELECTORS.filmReview, el => el.textContent.trim()).catch(() => reviewText);
                    await gotoTabCritiques(page, profileUrl);
                    for (let i = 1; i < pageNb; i++) {
                        if (await page.$(SELECTORS.nextPage)) {
                            await page.click(SELECTORS.nextPage);
                            await page.waitForSelector(SELECTORS.filmReviewBlock, { timeout: 4000 }).catch(() => {});
                        }
                    }
                } catch (e) {}
            }

            reviews.push({
                title: filmTitle,
                review: reviewText.replace(/\n/g, "").replace(/\s+/g, " ").trim()
            });
        }

        const nextPage = await page.$(SELECTORS.nextPage);
        if (nextPage) {
            try {
                await nextPage.click();
                await page.waitForSelector(SELECTORS.filmReviewBlock, { timeout: 7000 });
                pageNb++;
            } catch (e) {
                break;
            }
        } else {
            break;
        }
    }
    return reviews;
}

async function scrapeWishlist(page, profileUrl) {
    let url = profileUrl.replace(/\/films\/?$/, "/wishlist/films/");
    let wishlistFilms = [];
    const visitedUrls = new Set();

    while (true) {
        if (visitedUrls.has(url)) break;
        visitedUrls.add(url);

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (await page.$(SELECTORS.popupAcceptCookies)) {
            await page.click(SELECTORS.popupAcceptCookies);
            await page.waitForTimeout(600);
        }

        const films = await page.$$eval(SELECTORS.filmItem, els =>
            els.map(el => {
                const linkEl = el.querySelector('.meta-title.meta-title-link');
                return {
                    title: linkEl?.title?.trim() ?? "",
                    url: linkEl?.getAttribute('href') ?? ""
                };
            })
        );
        wishlistFilms = wishlistFilms.concat(films);

        const nextPage = await page.$(SELECTORS.nextPage);
        if (!nextPage) break;
        const nextHref = await page.evaluate(el => el.getAttribute('href'), nextPage);
        if (!nextHref || !nextHref.startsWith('http') || visitedUrls.has(nextHref)) break;
        url = nextHref;
    }
    return wishlistFilms;
}

function mergeFilmsAndReviews(films, reviews) {
    const revmap = Object.fromEntries(reviews.map(r => [r.title.normalize('NFD').replace(/\p{Diacritic}/gu, "").toLowerCase(), r.review]));
    return films.map(f => {
        let baseTitle = f.title.normalize('NFD').replace(/\p{Diacritic}/gu, "").toLowerCase();
        return {
            Title: f.title,
            Rating: f.rating,
            Review: revmap[baseTitle] ?? "",
            Url: getFullFilmUrl(f.url)
        };
    });
}

async function exportToCsv(filename, headers, data) {
    const csvWriter = createObjectCsvWriter({
        path: filename,
        header: headers.map(h => ({ id: h, title: h })),
        alwaysQuote: true
    });
    await csvWriter.writeRecords(data);
}

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

        const reviews = await scrapeAllReviews(page, url);
        if (reviews.length) console.log(`📝 ${reviews.length} critiques extraites.`);

        const wishlistFilms = await scrapeWishlist(page, url);
        if (wishlistFilms.length) {
            const wishlistWithUrls = wishlistFilms.map(f => ({
                Title: f.title,
                Url: getFullFilmUrl(f.url)
            }));
            await exportToCsv('allocine-wishlist.csv', ['Title', 'Url'], wishlistWithUrls);
            console.log('✅ Export : allocine-wishlist.csv');
        }

        if (films.length) {
            const entries = mergeFilmsAndReviews(films, reviews);
            await exportToCsv('allocine-url-info.csv', ['Title', 'Rating', 'Review', 'Url'], entries);
            console.log('✅ Export : allocine-url-info.csv');
        }
    } catch (err) {
        console.error('❌ Erreur:', err);
    } finally {
        await browser.close();
        console.log('🎉 Terminé !');
    }
})();
