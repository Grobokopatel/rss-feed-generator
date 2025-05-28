import 'dotenv/config';

import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { RequestInit } from 'node-fetch';
import cons from '@ladjs/consolidate';
import { Feed } from 'feed';
import * as cheerio from 'cheerio';
import { sql } from '@vercel/postgres';
import { join } from 'node:path';
import express from 'express';
import * as util from 'node:util';
import Hashids from 'hashids';
import { CheerioAPI } from 'cheerio';
import { FeedSelectors } from '../types/feed-selectors';
import { Enclosure } from 'feed/lib/typings';
import { resolve } from 'node:url';

const RUSSIAN_PROXY_URL = process.env.RUSSIAN_PROXY_URL as string;

const app = express();

app.engine('handlebars', cons.handlebars);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, '..', 'static')));
app.set('views', join(__dirname, '..', 'views'));
app.set('view engine', 'handlebars');

app.get('/', (req, res) => {
    res.sendFile(join(__dirname, '..', 'static', 'index.html'));
});

app.get('/my_feeds/:id', async (req, res) => {
    let queryResult;
    const public_key = req.params.id;
    let id = +public_key;
    if (isNaN(id)) {
        id = -1;
    }

    try {
        // второе условие для обратной совместимости
        queryResult = await sql`
            select id, url, selectors, last_time_updated, content, tab_title
            from feed
            where public_key = ${public_key}
               or id = ${id};
        `;
    } catch (error) {
        console.error(error);
        res.sendStatus(500);
        return;
    }

    let { rows } = queryResult;
    if (rows.length === 0) {
        res.status(404).send(`Нет ленты с таким id: ${public_key}`);
        return;
    } else {
        let { id, url, selectors, last_time_updated, content, tab_title } =
            rows[0];
        try {
            let result = await getTitleDescriptionAndImageEnclosure(
                selectors,
                url,
            );

            if (result === null) {
                res.send(
                    'Не удалось перейти по ссылке на сайте. Попробуйте другой селектор для перехода',
                );
            }

            let { title, description, imageEnclosure, newsLink } = result!;

            let currentContent =
                title + ';' + description + ';' + imageEnclosure?.url;

            let lastTimeUpdated = last_time_updated;
            if (content !== currentContent) {
                lastTimeUpdated = new Date();

                await sql`
                    update feed
                    set last_time_updated = ${lastTimeUpdated},
                    content = ${currentContent}
                    where id = ${id};
                `;
            }

            const feed = new Feed({
                title: tab_title,
                description: 'Сайт для генерации собственных RSS лент',
                link: url,
                language: 'ru',
            });

            feed.addItem({
                title,
                description,
                image: imageEnclosure,
                id: url + '#' + +lastTimeUpdated,
                date: lastTimeUpdated,
                link: newsLink,
            });
            let rssPost = feed.rss2();
            res.contentType('text/xml').send(rssPost);
            return;
        } catch (error) {
            console.error(error);
            res.sendStatus(500);
            return;
        }
    }
});

async function getTitleDescriptionAndImageEnclosure(
    selectors: FeedSelectors,
    url: string,
) {
    let response = await tryFetchElseFetchWithProxy(url);
    let html = await response.text();
    let $cheerioAPI = await cheerio.load(html);
    let newsLink = url;

    if (selectors.go_to_url) {
        let root_element = $cheerioAPI(selectors.go_to_url);
        let go_to_url = root_element.prop('href');

        if (go_to_url === undefined) {
            go_to_url = root_element.find('a').prop('href');

            if (go_to_url === undefined) {
                go_to_url = root_element.closest('a').prop('href');
            }
        }

        if (go_to_url === undefined) {
            return null;
        }

        go_to_url = resolve(url, go_to_url);
        newsLink = go_to_url;
        let response = await tryFetchElseFetchWithProxy(go_to_url);
        let html = await response.text();
        $cheerioAPI = await cheerio.load(html);
    }

    return {
        title: $cheerioAPI(selectors.title).prop('innerText') as string,
        description: $cheerioAPI(selectors.description).html() as string,
        imageEnclosure: (await getImageEnclosure(
            newsLink,
            $cheerioAPI,
            selectors.image,
        )) as Enclosure,
        newsLink,
    };
}

async function getImageEnclosure(
    pageUrl: string,
    $cheerioAPI: CheerioAPI,
    imageSelector: string,
) {
    if (!imageSelector) return null;

    let imageElement = $cheerioAPI(imageSelector);
    let imageUrl =
        imageElement.prop('src') ?? imageElement.find('img[src]').prop('src');

    if (imageUrl === undefined) {
        return null;
    }
    imageUrl = resolve(pageUrl, imageUrl);
    let imageInfo = await tryFetchElseFetchWithProxy(imageUrl, {
        method: 'HEAD',
    });
    let headers = imageInfo.headers;

    return {
        url: imageUrl,
        type: headers.get('content-type'),
        length: parseInt(headers.get('content-length') as string),
    } as Enclosure;
}

app.post('/api/create', async (req, res) => {
    let body = req.body;
    let selectors: FeedSelectors = {
        title: body.title,
        description: body.description,
        image: body.image,
        go_to_url: body.go_to_url,
    };

    let response = await tryFetchElseFetchWithProxy(body.url);
    let html = await response.text();
    let $cheerioAPI = await cheerio.load(html);
    let tab_title = $cheerioAPI('head title').text();

    const queryResult = await sql`
        select pg_sequence_last_value(pg_get_serial_sequence('feed', 'id'));`;
    let next_id = queryResult.rows[0].pg_sequence_last_value + 1;
    const public_key = new Hashids(process.env.public_key_salt, 10).encode(
        next_id,
    );
    const delete_key = new Hashids(process.env.delete_key_salt, 30).encode(
        next_id,
    );
    let today = new Date();
    try {
        await sql`
            insert into feed(url, selectors, last_time_updated, delete_key, public_key, creation_date, tab_title)
            values (${body.url},
                    ${selectors},
                    ${today},
                    ${delete_key},
                    ${public_key},
                    ${today},
                    ${tab_title})
            returning id;
        `;
    } catch (e) {
        console.log(e);
        res.sendStatus(500);
        return;
    }

    res.json({
        id: public_key,
        delete_key,
        url: body.url,
        tab_title,
        creation_date: today,
    });
});

app.get('/link-to-feed', async (req, res) => {
    let public_key = req.query.id;
    res.render('link-to-feed', {
        id: public_key,
    });
});

app.post('/feed-preview', async (req, res) => {
    let body = req.body;
    let selectors = {
        title: body.title,
        description: body.description,
        image: body.image,
        go_to_url: body.go_to_url,
    };

    let result = await getTitleDescriptionAndImageEnclosure(
        selectors,
        body.url,
    );
    if (result === null) {
        res.send(
            'Не удалось перейти по ссылке на сайте. Попробуйте другой селектор для перехода',
        );
    }

    let { title, description, imageEnclosure } = result!;

    res.render('feed-preview', {
        title,
        description,
        image: imageEnclosure?.url,
    });
});

app.post('/api/delete', async (req, res) => {
    let { delete_key } = req.body;
    let result;
    try {
        result = await sql`
            delete
            from feed
            where delete_key = ${delete_key};`;
    } catch (e) {
        console.log(e);
        res.sendStatus(500);
        return;
    }

    if (result.rowCount === 0) {
        res.sendStatus(404);
    } else {
        res.sendStatus(200);
    }
});

async function tryFetchElseFetchWithProxy(
    url: string,
    options: RequestInit = {},
) {
    try {
        let response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(
                `Got response code outside of 200-299: ${response.status} ${response.statusText}.\n` +
                    `Headers: ${util.inspect(response.headers)}`,
            );
        }

        return response;
    } catch (error) {
        console.error(error);
        options.agent = new HttpsProxyAgent(RUSSIAN_PROXY_URL);
        options.method = 'GET';
        let response = await fetch(url, options);

        if (!response.ok) {
            throw new Error(
                `Got response code outside of 200-299: ${response.status} ${response.statusText}.\n` +
                    `Headers: ${util.inspect(response.headers)}`,
            );
        }

        let headers = response.headers;
        headers.set(
            'content-length',
            headers.get('zr-content-length') as string,
        );
        headers.set('content-type', headers.get('zr-content-type') as string);

        return response;
    }
}

export default app;
