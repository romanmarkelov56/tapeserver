# Tape × SoundCloud

Это серверный каталог для Tape: само приложение остаётся интерфейсом плеера, а этот сервер получает каталог и аудио из SoundCloud и отдаёт их в формате [Tape Server API](https://airbagg.github.io/tape-site/TAPE_SERVER_API.html). Идея — пользоваться четырьмя вкладками Tape как музыкальным приложением на базе SoundCloud.

## Что работает в четырёх вкладках

- **Главная:** `/api/v1/public/stats` заполняет полку новинок реальными SoundCloud-плейлистами/релизами и обложками; `/library/me/top-tracks` отдаёт рекомендации, учитывающие My Vibe.
- **My Vibe:** `/library/tracks/random` использует недавно прослушанные и сохранённые треки как seed для SoundCloud related-треков. Если у пользователя ещё нет истории или избранного, сервер начинает с подборки жанров SoundCloud. Tape сообщает о прослушиваниях через `/library/plays`; сохраняются только компактные метаданные трека, не аудио.
- **Аккаунт:** `/library/liked` показывает сохранённые в Tape треки, `POST /library/liked/{track_id}` добавляет/убирает их; `/library/me/recent` и `/library/me/stats` возвращают локальную историю. Избранное не требует разрешений SoundCloud и не меняет лайки в SoundCloud.
- **Поиск:** один запрос ищет одновременно SoundCloud-треки, пользователей/исполнителей и плейлисты. Результаты маппятся в массивы `tracks`, `artists` и `albums`; страница исполнителя показывает его релизы и топ-треки, а релиз открывает полный список треков.

В API SoundCloud коллекции «альбомов» представлены плейлистами/релизами, поэтому Tape показывает их на album-экранах. Одиночный трек без связанного плейлиста открывается как однотрековый релиз. Воспроизведение идёт потоком SoundCloud с передачей Range для перемотки; аудио не скачивается и не хранится на сервере. Недоступные, заблокированные или географически ограниченные SoundCloud-треки могут не воспроизводиться.

## Настройка входа и SoundCloud

Создайте `.env` из шаблона:

```bash
cp .env.example .env
```

В Windows PowerShell: `Copy-Item .env.example .env`. Укажите SoundCloud OAuth-токен и учётные данные Tape:

```env
SOUNDCLOUD_ACCESS_TOKEN=ваш_soundcloud_oauth_token
TAPE_REQUIRE_AUTH=true
TAPE_USER_EMAIL=owner@tape.local
TAPE_USER_PASSWORD=ваш_пароль_минимум_8_символов
TAPE_JWT_SECRET=отдельный_случайный_секрет_минимум_32_символа
TAPE_DATA_DIR=./data
```

Секрет можно создать командой `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. В Tape нужно выполнить **вход** с тем же email и паролем. Для совместимости Tape маршрут регистрации существует, но он выдаёт сессию только для заранее заданной учётной записи владельца; публичные аккаунты создать нельзя. Это локальный вход Tape, не авторизация SoundCloud. Если пароль/JWT-секрет не заданы, сервер не запускается. Осознанный анонимный режим включается только явно: `TAPE_REQUIRE_AUTH=false`.

`SOUNDCLOUD_CLIENT_ID` можно оставить пустым, если он извлекается из JWT. SoundCloud OAuth-токен хранится только на сервере в `.env` — в Tape его вводить не нужно. `data/` содержит локальные избранные треки и историю; оба файла исключены из проекта/архива.

## Запуск и подключение телефона

```bash
npm install
npm run dev
```

Оставьте сервер на `127.0.0.1:8787`. Настройте приватный Tailscale Serve один раз на компьютере:

```bash
tailscale serve --bg 8787
```

В Tape укажите только базовый HTTPS-адрес Tailscale Serve, например `https://имя-компьютера.имя-tailnet.ts.net`. Не добавляйте `/api/v1`, `/health` или `127.0.0.1`. На iPhone должен быть включён Tailscale, а компьютер с сервером — включён.

Проверка Tape остаётся публичной: `GET /api/v1/public/stats` должен вернуть JSON. Поиск, artist/album pages, My Vibe, история, избранное и аудиопоток требуют входа. Поток также принимает `?token=...` для AVPlayer; защищайте адрес Tailscale и не публикуйте сервер напрямую в интернет.

## Основные маршруты

- `GET /api/v1/public/stats` — проверка подключения и домашняя полка новинок.
- `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` — локальная сессия Tape.
- `GET /api/v1/library/search?q=...` — совместный поиск треков, исполнителей и релизов.
- `GET /api/v1/library/artists`, `GET /api/v1/library/artists/{id}`, `GET /api/v1/library/artists/{id}/top-tracks` — каталог, профиль и топ-треки исполнителя.
- `GET /api/v1/library/albums/{id}` — детали альбома/плейлиста и треклист.
- `GET /api/v1/library/tracks/random?limit=...&exclude_ids=...` — рекомендации для My Vibe.
- `GET /api/v1/library/tracks/{id}/stream` — SoundCloud-поток с поддержкой `Range`.
- `POST /api/v1/library/plays`, `GET /api/v1/library/me/recent`, `GET /api/v1/library/me/stats` — история прослушиваний.
- `GET /api/v1/library/liked`, `POST /api/v1/library/liked/{track_id}` — избранное Tape.
- `GET /api/v1/library/cover/{id}`, `/library/track-cover/{id}`, `/library/artist-cover/{id}` — обложки релизов, треков и исполнителей.

Плейлисты, созданные пользователем в SoundCloud, пока доступны как поиск/просмотр релизов; редактирование SoundCloud-плейлистов и подписки на исполнителей не реализованы. Работа соответствует доступности SoundCloud API и правам авторов: см. [условия SoundCloud API](https://developers.soundcloud.com/docs/api/terms-of-use.html).

## Проверки

```bash
npm test
npm run build
npm start
```
