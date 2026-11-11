import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

/** UUID v7 primary key (time-ordered, so B-tree inserts stay append-mostly). */
export const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const newId = (): string => uuidv7();
