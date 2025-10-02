import APIConvertor, { parseCalendar } from './shared/lib/APIConvertor.js';
import mongoose from 'mongoose';
import LessonModel from './shared/models/LessonModel.js';

// Сделано для определения чётности недели
// Returns the ISO week of the date.
// Source: https://weeknumber.net/how-to/javascript
Date.prototype.getWeek = function() {
    let date = new Date(this.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    let week1 = new Date(date.getFullYear(), 0, 4);
    return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
};

mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGO_URI).then(() => {
    new (class Main {
        failedGroups: { name: string, fakId: number }[] = [];

        constructor() {
            let p: Promise<any> = Promise.resolve(0);

            console.log(process.argv);

            if(process.argv.includes('--force'))
                p = p.then(() => {
                    return this.removeAllData();
                });

            p.then(() => {
                return this.updateOfoSchedules();
            })
            .then(() => {
                return this.updateZfoSchedules();
            })
            .then(async () => {
                console.log('Не удалось для: ', this.failedGroups);

                await mongoose.disconnect();
                process.exit(0);
            });
        }

        async removeAllData() {
            console.log('[updater] Стираю старые расписания');
            return await LessonModel.deleteMany({});
        }

        async updateOfoSchedules() {
            console.log('[updater] Приступаю к обновлению очных расписаний!');
            console.log('[updater] Получаю список групп');

            let now = new Date();
            let ugod = now.getFullYear() - (now.getMonth() >= 6 ? 0 : 1);
            let sem = now.getMonth() > 5 ? 1 : 2;

            let resp = await APIConvertor.groupsList(ugod, { foe: 'ofo' });

            if(process.argv.includes('--debug')) console.log(`[updater] Ответ:`, resp);

            if(!resp || !resp.isok) return console.log('[updater] Ошибка!', resp?.error_message);

            /*
            Возможные проблемы:
            1. Я штурмую API сразу сотнями запросов. APIConvertor при неудаче будет стараться ещё раз, что ещё увеличит количество запросов.
            2. Если API не работает, код ниже всё равно отработает до конца, хотя смысла в этом не много
            */
            let groups = resp.data.map((g) => ({ name: g.name, fakId: g.inst_id }));
            let bulk = (await Promise.all(groups.map(async (group) => {
                let out = [];
                let schedule = await APIConvertor.ofo(group.name, ugod, sem); // Получение расписания
                let lessonsStartDate = await parseCalendar(group.name, sem, ugod); // Получения графика (с какого по какую дату)

                if(!schedule?.isok) {
                    console.log(`[updater] [-] Не удалось получить расписание для ${group.name}`);
                    this.failedGroups.push(group);
                    return [];
                }

                out.push({ deleteMany: { filter: { group: group.name } } });

                schedule.data.forEach((l) => {
                    if('nedType' in l.day && lessonsStartDate)
                        l.day.weeks.startDate = new Date(lessonsStartDate.valueOf() + 1000 * 60 * 60 * 24 * 7 * (l.day.weeks.from - 1));

                    out.push({ insertOne: { document: { ...l, group: group.name } } })
                });

                console.log(`[updater] [+] ${group.name}`);

                return out;
            }))).flat();

            if (bulk.length) await LessonModel.bulkWrite(bulk).catch(console.error);
        }

        async updateZfoSchedules() {
            console.log('[updater] Приступаю к обновлению заочных расписаний!');
            console.log('[updater] Получаю список групп');

            let now = new Date();
            let ugod = now.getFullYear() - (now.getMonth() >= 6 ? 0 : 1);
            let sem = now.getMonth() > 5 ? 1 : 2;

            let resp = await APIConvertor.groupsList(ugod, { foe: 'zfo' });

            if(process.argv.includes('--debug')) console.log(`[updater] Ответ:`, resp);

            if(!resp || !resp.isok) return console.log('[updater] Ошибка!', resp?.error_message);

            let groups = resp.data.map((g) => ({ name: g.name, fakId: g.inst_id }));
            let bulk = (await Promise.all(groups.map(async (group) => {
                let out = [];
                let schedule = await APIConvertor.zfo(group.name, ugod, sem); // Получение расписания

                if(!schedule?.isok) {
                    console.log(`[updater] [-] Не удалось получить расписание для ${group.name}`);
                    this.failedGroups.push(group);
                    return [];
                }

                out.push({ deleteMany: { filter: { group: group.name } } });

                schedule.data.forEach((l) => {
                    out.push({ insertOne: { document: { ...l, group: group.name } } })
                });

                console.log(`[updater] [+] ${group.name}`);

                return out;
            }))).flat();

            if (bulk.length) await LessonModel.bulkWrite(bulk).catch(console.error);
        }
    })();
}, console.log);
