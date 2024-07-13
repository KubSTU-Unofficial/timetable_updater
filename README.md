# timetable_updater

### Установка

```bash
git clone git@github.com:KubSTU-Unofficial/timetable_updater.git
git submodule update
npm i
npx tsc
```

Создать `.env` файл
```
MONGO_URI=mongodb://localhost:27017/kubstu
KUBSTU_API=API КубГТУ
```

### Запуск

Обновить расписание:
```bash
npm run update
```

`--force` Полное обновление (перед удалением очищает сохранённые расписание)<br>
`--debug` Больше информации

Вводить аргументы через `--`
```bash
npm run update -- --force
```
