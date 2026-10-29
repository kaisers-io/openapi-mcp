// The evaluation tasks. Each one names what it exercises, a prompt in English
// and German, and a check that reads the final answer and the API's recorded
// state. Expected values are computed from the generated data, never typed in.

import { orderEvents } from './fake-api.ts';
import type { Data, startFakeApi } from './fake-api.ts';

type Api = Awaited<ReturnType<typeof startFakeApi>>;
export interface Verdict {
  correct: boolean;
  expected: string;
  note?: string;
}
export interface Task {
  id: string;
  exercises: string;
  prompt: { en: string; de: string };
  check: (answer: string, api: Api) => Verdict;
}

// Reads numbers in English (5,920.66) and German (5.920,66) notation
const numbers = (text: string) =>
  [...text.matchAll(/-?\d[\d.,]*/gu)].flatMap((match) => {
    const raw = match[0].replace(/[.,]$/u, '');
    const german = /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$|^-?\d+,\d{1,2}$/u.test(raw);
    const value = german ? raw.replaceAll('.', '').replace(',', '.') : raw.replaceAll(',', '');
    return Number.isNaN(Number(value)) ? [] : [Number(value)];
  });
const hasNumber = (text: string, value: number, tolerance = 0) =>
  numbers(text).some((found) => Math.abs(found - value) <= tolerance);
const has = (text: string, needle: string) => text.toLowerCase().includes(needle.toLowerCase());

const newestOrder = (data: Data, customerId: string) =>
  data.orders.findLast((order) => order.customerId === customerId)!;
const openTickets = (data: Data) => {
  const counts = new Map<string, number>();
  for (const ticket of data.tickets) {
    if (ticket.status === 'open') {
      counts.set(ticket.customerId, (counts.get(ticket.customerId) ?? 0) + 1);
    }
  }
  return [...counts].toSorted((left, right) => right[1] - left[1]);
};

export const TASKS: Task[] = [
  {
    id: 'lookup',
    exercises: 'one direct call',
    prompt: {
      en: 'What is the email address of customer C-017?',
      de: 'Wie lautet die E-Mail-Adresse von Kunde C-017?',
    },
    check: (answer, { data }) => {
      const { email } = data.customers.find((customer) => customer.id === 'C-017')!;
      return { correct: has(answer, email), expected: email };
    },
  },
  {
    id: 'pagination',
    exercises: 'paging through all customers and counting',
    prompt: {
      en: 'How many customers are based in Germany (country code DE)? Give the exact number.',
      de: 'Wie viele Kunden haben ihren Sitz in Deutschland (Ländercode DE)? Nenne die genaue Zahl.',
    },
    check: (answer, { data }) => {
      const count = data.customers.filter((customer) => customer.country === 'DE').length;
      return { correct: hasNumber(answer, count), expected: String(count) };
    },
  },
  {
    id: 'chain',
    exercises: 'three dependent calls',
    prompt: {
      en: 'In the most recent order of customer C-008, which product was ordered in the largest quantity? Give the product name.',
      de: 'Welches Produkt wurde in der neuesten Bestellung von Kunde C-008 in der größten Menge bestellt? Nenne den Produktnamen.',
    },
    check: (answer, { data }) => {
      const order = newestOrder(data, 'C-008');
      const top = order.items.toSorted((left, right) => right.quantity - left.quantity)[0]!;
      const { name } = data.products.find((product) => product.sku === top.sku)!;
      return { correct: has(answer, name), expected: name };
    },
  },
  {
    id: 'fanout',
    exercises: 'listing with a filter, then one detail call per item, then a sum',
    prompt: {
      en: 'What is the sum of the totals of all cancelled orders? Give the amount with two decimals.',
      de: 'Wie hoch ist die Summe der Gesamtbeträge aller stornierten Bestellungen? Nenne den Betrag mit zwei Nachkommastellen.',
    },
    check: (answer, { data }) => {
      const cancelled = data.orders.filter((order) => order.status === 'cancelled');
      const sum =
        Math.round(cancelled.reduce((total, order) => total + order.total, 0) * 100) / 100;
      return { correct: hasNumber(answer, sum, 0.011), expected: sum.toFixed(2) };
    },
  },
  {
    id: 'large-result',
    exercises: 'finding one entry in a large response',
    prompt: {
      en: 'At what exact time (timestamp) did order O-1043 change to status "delivered"?',
      de: 'Zu welchem genauen Zeitpunkt (Zeitstempel) wechselte Bestellung O-1043 in den Status "delivered"?',
    },
    check: (answer, { data }) => {
      const { at } = orderEvents(data, 'O-1043')!.find((event) => event.status === 'delivered')!;
      // Accept the timestamp with or without milliseconds or the Z suffix
      const core = at.slice(0, 19);
      // Also as a date and a time apart ("2026-03-08 um 12:11:08")
      const [date = '', time = ''] = core.split('T');
      return {
        correct: has(answer, core) || (has(answer, date) && has(answer, time)),
        expected: at,
      };
    },
  },
  {
    id: 'similar-names',
    exercises: 'choosing between operations with similar names',
    prompt: {
      en: 'How many units of product P-05 are currently on hand in warehouse W-2?',
      de: 'Wie viele Einheiten von Produkt P-05 liegen aktuell im Lager W-2?',
    },
    check: (answer, { data }) => {
      const row = data.stock.find((stock) => stock.warehouseId === 'W-2' && stock.sku === 'P-05')!;
      return { correct: hasNumber(answer, row.onHand), expected: String(row.onHand) };
    },
  },
  {
    id: 'aggregate',
    exercises: 'paging, grouping and picking a maximum',
    prompt: {
      en: 'Which customer has the most open support tickets? Answer with the customer ID.',
      de: 'Welcher Kunde hat die meisten offenen Support-Tickets? Antworte mit der Kunden-ID.',
    },
    check: (answer, { data }) => {
      const [id] = openTickets(data)[0]!;
      return { correct: has(answer, id), expected: id };
    },
  },
  {
    id: 'filter-nullable',
    exercises: 'paging with a filter and handling null values',
    prompt: {
      en: 'Which customers on the "pro" tier have no phone number on file? List their customer IDs.',
      de: 'Welche Kunden im Tarif "pro" haben keine Telefonnummer hinterlegt? Liste ihre Kunden-IDs auf.',
    },
    check: (answer, { data }) => {
      const ids = data.customers
        .filter((customer) => customer.tier === 'pro' && customer.phone === null)
        .map((customer) => customer.id);
      const wrong = data.customers
        .filter((customer) => !ids.includes(customer.id) && has(answer, customer.id))
        .map((customer) => customer.id);
      return {
        correct: ids.every((id) => has(answer, id)) && wrong.length === 0,
        expected: ids.join(', '),
        ...(wrong.length > 0 ? { note: `extra: ${wrong.join(', ')}` } : {}),
      };
    },
  },
  {
    id: 'write-unclear',
    exercises: 'a write whose response does not say whether it happened',
    prompt: {
      en: 'Open a support ticket for customer C-003 with the subject "Late delivery of order O-1050".',
      de: 'Eröffne ein Support-Ticket für Kunde C-003 mit dem Betreff "Late delivery of order O-1050".',
    },
    check: (_answer, { tickets }) => {
      const made = tickets.filter(
        (ticket) =>
          ticket.customerId === 'C-003' && ticket.subject === 'Late delivery of order O-1050',
      ).length;
      return { correct: made === 1, expected: 'exactly one ticket', note: `${made} created` };
    },
  },
];

// Harder tasks for the large API: more calls, joins across resources and
// aggregation over many results
const revenueOf = (data: Data, country: string) =>
  Math.round(
    data.orders
      .filter(
        (order) =>
          order.status !== 'cancelled' &&
          data.customers.find((customer) => customer.id === order.customerId)?.country === country,
      )
      .reduce((sum, order) => sum + order.total, 0) * 100,
  ) / 100;
const topSku = (data: Data, month: string) => {
  const quantity = new Map<string, number>();
  const delivered = data.orders.filter(
    (order) => order.status === 'delivered' && order.createdAt.startsWith(month),
  );
  for (const order of delivered) {
    for (const item of order.items) {
      quantity.set(item.sku, (quantity.get(item.sku) ?? 0) + item.quantity);
    }
  }
  return [...quantity].toSorted((left, right) => right[1] - left[1]);
};
const lowStock = (data: Data, below: number) =>
  data.products
    .map((product) => product.sku)
    .filter(
      (sku) =>
        data.stock.filter((row) => row.sku === sku).reduce((sum, row) => sum + row.onHand, 0) <
        below,
    );
const scansBeforeShipped = (data: Data, orderId: string) => {
  const events = orderEvents(data, orderId)!;
  const shipped = events.findIndex((event) => event.status === 'shipped');
  return events.slice(0, shipped).filter((event) => event.type === 'tracking.scan').length;
};

// The distinct SKUs in the order the answer first names them
const skusIn = (answer: string) => [...new Set(answer.match(/\bP-\d{2}\b/gu))];

export const HARD_TASKS: Task[] = [
  {
    id: 'join-revenue',
    exercises: 'customers by country, their orders, each order total (about 40 calls)',
    prompt: {
      en: 'What is the total revenue of all orders that are not cancelled from customers based in Austria (country code AT)? Give the amount with two decimals.',
      de: 'Wie hoch ist der Gesamtumsatz aller nicht stornierten Bestellungen von Kunden mit Sitz in Österreich (Ländercode AT)? Nenne den Betrag mit zwei Nachkommastellen.',
    },
    check: (answer, { data }) => {
      const sum = revenueOf(data, 'AT');
      return { correct: hasNumber(answer, sum, 0.011), expected: sum.toFixed(2) };
    },
  },
  {
    id: 'top-product',
    exercises: 'paging a filtered list, a date filter, item details and a ranking',
    prompt: {
      en: 'Across all delivered orders created in April 2026, which product SKU was ordered in the largest total quantity?',
      de: 'Welche Produkt-SKU wurde über alle gelieferten Bestellungen, die im April 2026 angelegt wurden, in der größten Gesamtmenge bestellt?',
    },
    check: (answer, { data }) => {
      const [sku] = topSku(data, '2026-04')[0]!;
      // The answer names the winner first; runners-up may follow
      return { correct: skusIn(answer)[0] === sku, expected: sku };
    },
  },
  {
    id: 'low-stock',
    exercises: 'one stock call per product next to similarly named stock operations',
    prompt: {
      en: 'Which products currently have fewer than 450 units on hand in total across all warehouses? List their SKUs.',
      de: 'Welche Produkte haben aktuell über alle Lager zusammen weniger als 450 Einheiten auf Lager? Liste ihre SKUs auf.',
    },
    check: (answer, { data }) => {
      const skus = lowStock(data, 450);
      // The list comes first; a later remark such as "checked P-01 to P-20" does not count
      const listed = new Set(skusIn(answer).slice(0, skus.length));
      return { correct: skus.every((sku) => listed.has(sku)), expected: skus.join(', ') };
    },
  },
  {
    id: 'count-events',
    exercises: 'counting within a large response',
    prompt: {
      en: 'How many "tracking.scan" events did order O-1043 have before its status changed to "shipped"?',
      de: 'Wie viele "tracking.scan"-Ereignisse hatte Bestellung O-1043, bevor ihr Status zu "shipped" wechselte?',
    },
    check: (answer, { data }) => {
      const count = scansBeforeShipped(data, 'O-1043');
      return { correct: hasNumber(answer, count), expected: String(count) };
    },
  },
];
