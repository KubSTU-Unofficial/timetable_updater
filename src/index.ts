import APIConvertor, { FoE } from './shared/lib/APIConvertor.js';
import OScheduleModel from './shared/models/OScheduleModel.js';
import ZScheduleModel from './shared/models/ZScheduleModel.js';
import TeacherScheduleModel from './shared/models/TeacherScheduleModel.js';
import { default as Group } from './shared/structures/Group.js';
import mongoose from 'mongoose';
import { weekNumber } from './shared/lib/Utils.js';
import { ITeacherLesson, ITeacherDay } from './shared/structures/Teacher.js';

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
                    return this.updateTeacherSchedules();
                })
                .then(() => {
                    return process.exit(0);
                });
        }

        compare(lesson1: ITeacherLesson, lesson2: ITeacherLesson) {
            return (
                lesson1.number == lesson2.number &&
                lesson1.time == lesson2.time &&
                lesson1.name == lesson2.name &&
                lesson1.paraType == lesson2.paraType &&
                lesson1.auditory == lesson2.auditory &&
                (lesson1.period == lesson2.period ||
                    (lesson1.period && lesson2.period && lesson1.period[0] == lesson2.period[0] && lesson1.period[1] == lesson2.period[1]))
            );
        }

        combine(lesson1: ITeacherLesson, lesson2: ITeacherLesson) {
            let out: ITeacherLesson = { ...lesson1 };

            out.group = `${lesson1.group} | ${lesson2.group}`;

            return out;
        }

        getMonday(oldDate: Date) {
            let date = new Date(oldDate);
            date.setDate(date.getDate() - (date.getDay() == 7 ? 0 : date.getDay()) + 1);
            return date;
        }

        async removeAllData() {
            console.log('[updater] Стираю старые расписания');
            return Promise.all([OScheduleModel.collection.drop(), ZScheduleModel.collection.drop(), TeacherScheduleModel.collection.drop()]).then(
                (values) => {
                    console.log(values);
                    if (values.every((v) => v)) console.log('[updater] Старые расписания стёрты');
                },
            );
        }

        async updateOfoSchedules() {
            console.log('[updater] Приступаю к обновлению очных расписаний!');
            console.log('[updater] Получаю список групп');

            let now = new Date();
            let ugod = now.getFullYear() - (now.getMonth() >= 6 ? 0 : 1);
            let sem = now.getMonth() > 5 ? 1 : 2;

            let resp = await APIConvertor.groupsList(ugod, { foe: FoE.ofo });

            if (process.argv.includes('--debug')) console.log(`[updater] Ответ:`, resp);

            if (!resp || !resp.isok) return console.log('[updater] Ошибка!', resp?.error_message);

            let groups = resp.data.map((g) => ({ name: g.name, inst_id: g.inst_id }));
            let bulk = OScheduleModel.collection.initializeOrderedBulkOp();

            // Преобразует массив из строк в массив из обещаний, которые потом одновременно исполняются.
            await Promise.all(
                groups.map((group) =>
                    (async function () {
                        let schedule = await APIConvertor.ofo(group.name, ugod, sem);
                        let lessonsStartDate = await APIConvertor.parseCalendar(group.name, sem, ugod);

                        if (!schedule || !schedule.isok) return console.log(`[updater] [-] Не удалось для ${group.name}`);

                        bulk.find({ group: group.name, inst_id: group.inst_id })
                            .upsert()
                            .updateOne({ $set: { data: schedule.data, lessonsStartDate, updateDate: now } });

                        console.log(`[updater] [+] ${group.name}`);
                    })(),
                ),
            ).then(async () => {
                await bulk.execute().then(() => console.log(`[updater] Очные расписания обновлены!`), console.log); // Отправляем изменения в БД
            });
        }

        async updateZfoSchedules() {
            console.log('[updater] Приступаю к обновлению заочных расписаний!');
            console.log('[updater] Получаю список групп');

            let now = new Date();
            let ugod = now.getFullYear() - (now.getMonth() >= 6 ? 0 : 1);
            let sem = now.getMonth() > 5 ? 1 : 2;

            let [groupsList1, groupsList2] = await Promise.all([
                APIConvertor.groupsList(ugod, { foe: FoE.zfo }),
                APIConvertor.groupsList(ugod, { foe: FoE.ozfo }),
            ]);

            if (process.argv.includes('--debug')) console.log(`[updater] Ответ:`, groupsList1, groupsList2);
            if (!groupsList1 || !groupsList1.isok || !groupsList2 || !groupsList2.isok)
                return console.log('[updater] Ошибка!', groupsList1?.error_message, groupsList2?.error_message);

            let resp = [...groupsList1.data, ...groupsList2.data];
            let groups = resp.map((g) => ({ name: g.name, inst_id: g.inst_id }));
            let bulk = ZScheduleModel.collection.initializeOrderedBulkOp();

            // Преобразует массив из строк в массив из обещаний, которые потом одновременно исполняются.
            await Promise.all(
                groups.map((group) =>
                    (async function () {
                        let schedule = await APIConvertor.zfo(group.name, ugod, sem);

                        if (!schedule || !schedule.isok) return console.log(`[updater] [-] Не удалось для ${group.name}`);

                        bulk.find({ group: group.name, inst_id: group.inst_id })
                            .upsert()
                            .updateOne({ $set: { data: schedule.data, updateDate: now } });

                        console.log(`[updater] [+] ${group.name}`);
                    })(),
                ),
            ).then(async () => {
                await bulk.execute().then(() => console.log(`[updater] Заочные расписания обновлены!`), console.log); // Отправляем изменения в БД
            });
        }

        async updateTeacherSchedules() {
            console.log(`[updater] Приступаю к обновлению расписаний преподавателей!`);

            let oSchedules = await OScheduleModel.find({}).exec(); // Получение всех очных расписаний
            let zSchedules = await ZScheduleModel.find({}).exec(); // Получение всех заочных расписаний
            let teachersScheduleDB = await TeacherScheduleModel.find({}).exec(); // Получение всех расписаний преподавателей
            let teachersSchedule: { [key: string]: ITeacherDay[] } = {}; // Тут будут храниться расписания у преподавателей
            let updateDate = new Date(); // Дата обновления (сейчас)

            let mondayDate = this.getMonday(new Date()); // Получаем понедельник текущей недели
            let endDate = new Date(mondayDate); // Конечная дата
            endDate.setDate(mondayDate.getDate() + 13);

            oSchedules.forEach((group) => {
                if (!group.data || group.data.length == 0) return; // Если у группы нет пар, значит пропускаем её
                if (!group.lessonsStartDate) return; // Не получится чётко установить положение группы, если у меня не будет начальной даты

                let weekNum = weekNumber(group.lessonsStartDate, mondayDate); // Номер текущий недели

                group.data.forEach((lesson) => {
                    if (lesson.teacher == 'Не назначен') return;
                    if (!(lesson.ned_from! <= weekNum && lesson.ned_to! >= weekNum + 1)) return;

                    if (!teachersSchedule[lesson.teacher!]) teachersSchedule[lesson.teacher!] = []; // Создаём для преподавателя массив его дней, если этого массива нет

                    // Переменная содержащая инфу о паре
                    let out: ITeacherLesson = {
                        group: group.group,
                        number: lesson.pair!,
                        time: `${Group.lessonsTime[lesson.pair!][0]} - ${Group.lessonsTime[lesson.pair!][1]}`,
                        name: lesson.disc?.disc_name!,
                        paraType: Group.lessonsTypes[lesson.kindofnagr?.kindofnagr_name!]!,
                        auditory: lesson.classroom!,
                        period: [lesson.ned_from!, lesson.ned_to!],
                    };

                    if (lesson.comment) out.remark = lesson.comment;
                    if (lesson.persent_of_gr != 100) out.percent = `${lesson.persent_of_gr}%`;
                    if (lesson.ispotok) out.flow = lesson.ispotok;

                    // Тут добавляем сам день, а если он уже есть, то вставляем в него пару
                    if (
                        !teachersSchedule[lesson.teacher!].find(
                            (elm) => elm.daynum == lesson.dayofweek?.dayofweek_id && elm.even == (lesson.nedtype?.nedtype_id == 2),
                        )
                    )
                        teachersSchedule[lesson.teacher!].push({
                            daynum: lesson.dayofweek?.dayofweek_id!,
                            even: lesson.nedtype?.nedtype_id == 2,
                            daySchedule: [out],
                        });
                    else
                        teachersSchedule[lesson.teacher!]
                            .find((elm) => elm.daynum == lesson.dayofweek?.dayofweek_id && elm.even == (lesson.nedtype?.nedtype_id == 2))!
                            .daySchedule.push(out);
                });
            });

            // Почти тоже самое для заочников
            zSchedules.forEach((group) => {
                if (!group.data || group.data.length == 0) return; // Если у группы нет пар, значит пропускаем её

                group.data.forEach((lesson) => {
                    if (lesson.teacher == 'Не назначен') return;

                    let lessonDate = new Date(lesson.datez!);

                    if (lessonDate < mondayDate || lessonDate > endDate) return;

                    let lessonDayOfWeek = lessonDate.getDay();
                    let lessonWeekEven = lessonDate.getWeek() % 2 == 0;

                    if (!teachersSchedule[lesson.teacher!]) teachersSchedule[lesson.teacher!] = []; // Создаём для преподавателя массив его дней, если этого массива нет

                    // Переменная содержащая инфу о паре
                    let out: ITeacherLesson = {
                        group: group.group,
                        number: lesson.pair!,
                        time: `${Group.lessonsTime[lesson.pair!][0]} - ${Group.lessonsTime[lesson.pair!][1]}`,
                        name: lesson.disc?.disc_name!,
                        paraType: Group.lessonsTypes[lesson.kindofnagr?.kindofnagr_name!]!,
                        auditory: lesson.classroom!,
                    };

                    if (lesson.comment) out.remark = lesson.comment;

                    // Тут добавляем сам день, а если он уже есть, то вставляем в него пару
                    if (!teachersSchedule[lesson.teacher!].find((elm) => elm.daynum == lessonDayOfWeek && elm.even == lessonWeekEven))
                        teachersSchedule[lesson.teacher!].push({
                            daynum: lessonDayOfWeek,
                            even: lessonWeekEven,
                            daySchedule: [out],
                        });
                    else
                        teachersSchedule[lesson.teacher!]
                            .find((elm) => elm.daynum == lessonDayOfWeek && elm.even == lessonWeekEven)!
                            .daySchedule.push(out);
                });
            });

            // Создаём очередь изменений
            let bulk = TeacherScheduleModel.collection.initializeOrderedBulkOp();

            // Находим учителей, которых не оказалось в расписании
            let teacherNames = Object.keys(teachersSchedule);
            let absentTeachers = teachersScheduleDB.map((elm) => elm.name).filter((elm) => !teacherNames.includes(elm));

            // Очищаем их расписание
            if (absentTeachers.length) bulk.find({ name: { $in: absentTeachers } }).update({ $set: { data: [], updateDate } });

            for (let teacher in teachersSchedule) {
                // Сортируем по дням недели
                teachersSchedule[teacher].sort((a, b) => a.daynum - b.daynum);

                for (let day in teachersSchedule[teacher]) {
                    // Сортируем по номерам пар
                    teachersSchedule[teacher][day].daySchedule.sort((a, b) => a.number - b.number);

                    // Объединение одинаковых пар
                    for (let i = 0; i < teachersSchedule[teacher][day].daySchedule.length - 1; i++) {
                        if (this.compare(teachersSchedule[teacher][day].daySchedule[i], teachersSchedule[teacher][day].daySchedule[i + 1])) {
                            teachersSchedule[teacher][day].daySchedule[i] = this.combine(
                                teachersSchedule[teacher][day].daySchedule[i],
                                teachersSchedule[teacher][day].daySchedule[i + 1],
                            );
                            teachersSchedule[teacher][day].daySchedule.splice(i + 1, 1);
                            i--;
                        }
                    }
                }

                // Добавляем в очередь ещё одно изменение
                bulk.find({ name: teacher })
                    .upsert()
                    .updateOne({ $set: { updateDate, days: teachersSchedule[teacher] } });
            }

            await bulk.execute().then(() => console.log(`[updater] Расписания преподавателей обновлены!`), console.log);
        }
    })();
}, console.log);
