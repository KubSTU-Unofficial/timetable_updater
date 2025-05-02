import APIConvertor from './shared/lib/APIConvertor.js';
import mongoose from 'mongoose';
import LessonModel, { ILessonSchema } from './shared/models/LessonModel.js';

// Сделано для определения чётности недели
// Returns the ISO week of the date.
// Source: https://weeknumber.net/how-to/javascript
Date.prototype.getWeek = function () {
    let date = new Date(this.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    let week1 = new Date(date.getFullYear(), 0, 4);
    return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
};

mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGO_URI).then(() => {
    new (class Main {
        constructor() {
            let p: Promise<any> = Promise.resolve(0);

            console.log(process.argv);

            if (process.argv.includes('--force'))
                p = p.then(() => {
                    return this.removeAllData();
                });

            p.then(() => {
                return this.updateOfoSchedules();
            })
                .then(() => {
                    return this.updateZfoSchedules();
                })
                .then(() => {
                    return mongoose.disconnect();
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

            if (process.argv.includes('--debug')) console.log(`[updater] Ответ:`, resp);

            if (!resp || !resp.isok) return console.log('[updater] Ошибка!', resp?.error_message);

            let groups = resp.data.map((g) => ({ name: g.name, inst_id: g.inst_id }));
            const results = await Promise.allSettled(groups.map(async (group) => {
                try {
                    let schedule = await APIConvertor.ofo(group.name, ugod, sem);
                    let lessonsStartDate = await APIConvertor.parseCalendar(group.name, sem, ugod);

                    if (!schedule || !schedule.isok) {
                        console.log(`[updater] [-] Не удалось для ${group.name}`);
                        return [];
                    }

                    let lessons: ILessonSchema[] = schedule.data.map((l) => {
                        if ('nedType' in l.day && lessonsStartDate)
                            l.day.weeks.startDate = new Date(lessonsStartDate.valueOf() + 1000 * 60 * 60 * 24 * 7 * (l.day.weeks.from - 1));

                        return { ...l, group: group.name };
                    });

                    console.log(`[updater] [+] ${group.name}`);
                    return lessons;
                } catch (e) {
                    console.log(`[updater] [!] Ошибка для ${group.name}:`, e);
                    return [];
                }
            }));

            let result: ILessonSchema[] = results
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => (r as PromiseFulfilledResult<ILessonSchema[]>).value);

            await LessonModel.insertMany(result).catch(console.error);
        }

        async updateZfoSchedules() {
            console.log('[updater] Приступаю к обновлению заочных расписаний!');
            console.log('[updater] Получаю список групп');

            let now = new Date();
            let ugod = now.getFullYear() - (now.getMonth() >= 6 ? 0 : 1);
            let sem = now.getMonth() > 5 ? 1 : 2;

            let resp = await APIConvertor.groupsList(ugod, { foe: 'zfo' });

            if (process.argv.includes('--debug')) console.log(`[updater] Ответ:`, resp);

            if (!resp || !resp.isok) return console.log('[updater] Ошибка!', resp?.error_message);

            let groups = resp.data.map((g) => ({ name: g.name, inst_id: g.inst_id }));
            const results = await Promise.allSettled(groups.map(async (group) => {
                try {
                    let schedule = await APIConvertor.zfo(group.name, ugod, sem);

                    if (!schedule || !schedule.isok) {
                        console.log(`[updater] [-] Не удалось для ${group.name}`);
                        return [];
                    }

                    let lessons: ILessonSchema[] = schedule.data.map((l) => {
                        return { ...l, group: group.name };
                    });

                    console.log(`[updater] [+] ${group.name}`);
                    return lessons;
                } catch (e) {
                    console.log(`[updater] [!] Ошибка для ${group.name}:`, e);
                    return [];
                }
            }));

            let result: ILessonSchema[] = results
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => (r as PromiseFulfilledResult<ILessonSchema[]>).value);

            await LessonModel.insertMany(result).catch(console.error);
        }
    })();
}, console.log);
