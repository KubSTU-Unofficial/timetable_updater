declare global {
    namespace NodeJS {
        interface ProcessEnv {
            MONGO_URI: string;
            TOKEN: string;
            KUBSTI_API: string;
        }
    }

    // Они не определяются в index.ts, но тк они и не используются, это неважно
    interface Date {
        getWeek(): number;
        stringDate(): string;
    }
}

export {};
