export function createDatePickerValue(date: string | null) {
  const value = new Date();

  if (date) {
    const [year, month, day] = date.split("-").map(Number);
    value.setFullYear(year, month - 1, day);
  }

  return value;
}

export function createTimePickerValue(time: string | null) {
  const value = new Date();

  if (time) {
    const [hour, minute] = time.split(":").map(Number);
    value.setHours(hour, minute, 0, 0);
  }

  return value;
}

export function formatLocalDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function formatLocalTime(value: Date) {
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");

  return `${hour}:${minute}`;
}
