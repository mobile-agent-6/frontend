import { SymbolView } from "expo-symbols";
import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { Calendar, LocaleConfig, type CalendarProps } from "react-native-calendars";

import { Spacing } from "@/constants/theme";
import { ThemedText } from "@/components/ui/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { formatLocalDate } from "@/utils/schedule-date-time";

const saturdayColor = "#0EA5E9";

// Calendar의 기본 locale API로 요일 표시와 접근성 요일 이름을 한국어로 설정한다.
LocaleConfig.locales.ko = {
  ...LocaleConfig.locales[""],
  dayNames: ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"],
  dayNamesShort: ["일", "월", "화", "수", "목", "금", "토"],
};
LocaleConfig.defaultLocale = "ko";

type MonthCalendarProps = {
  /** YYYY-MM-DD 형식. 일반적으로 현재 표시 중인 월의 1일을 사용한다. */
  visibleMonth: string;
  /** YYYY-MM-DD 형식 */
  selectedDate: string;
  /** 부모에서 전달받은 일정 날짜 목록. 완료된 일정도 포함한다. */
  scheduleDates: readonly string[];
  onSelectDate: NonNullable<CalendarProps["onDayPress"]>;
  onMonthChange: NonNullable<CalendarProps["onMonthChange"]>;
};

export function MonthCalendar({
  visibleMonth,
  selectedDate,
  scheduleDates,
  onSelectDate,
  onMonthChange,
}: MonthCalendarProps) {
  const theme = useTheme();
  const today = formatLocalDate(new Date());
  const markedDates = useMemo<NonNullable<CalendarProps["markedDates"]>>(() => {
    const scheduleMarkings: NonNullable<CalendarProps["markedDates"]> =
      Object.fromEntries(scheduleDates.map((date) => [date, { marked: true }]));

    const [year, month] = visibleMonth.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const weekendMarkings = Object.fromEntries(
      Array.from({ length: daysInMonth }, (_, index) => {
        const date = new Date(year, month - 1, index + 1);
        const dateString = formatLocalDate(date);
        const weekday = date.getDay();

        // 현재 월의 주말에만 적용하고 오늘·선택 날짜의 색상은 유지한다.
        if (
          (weekday !== 0 && weekday !== 6) ||
          dateString === today ||
          dateString === selectedDate
        ) {
          return [];
        }

        return [
          [
            dateString,
            {
              ...scheduleMarkings[dateString],
              customStyles: {
                text: { color: weekday === 0 ? theme.destructive : saturdayColor },
              },
            },
          ],
        ];
      }).flat(),
    );

    return {
      ...scheduleMarkings,
      ...weekendMarkings,
      [selectedDate]: {
        ...scheduleMarkings[selectedDate],
        selected: true,
      },
    };
  }, [scheduleDates, selectedDate, visibleMonth, today, theme.destructive]);

  return (
    <Calendar
      style={[
        styles.panel,
        {
          backgroundColor: theme.background,
          borderColor: theme.backgroundElement,
        },
      ]}
      headerStyle={styles.header}
      initialDate={visibleMonth}
      monthFormat="yyyy년 M월"
      renderArrow={(direction) => (
        <SymbolView
          name={
            direction === "left"
              ? { ios: "chevron.left", android: "chevron_left", web: "chevron_left" }
              : { ios: "chevron.right", android: "chevron_right", web: "chevron_right" }
          }
          size={16}
          tintColor={theme.textSecondary}
          fallback={
            <ThemedText themeColor="textSecondary" style={styles.arrowFallback}>
              {direction === "left" ? "‹" : "›"}
            </ThemedText>
          }
        />
      )}
      markedDates={markedDates}
      markingType="custom"
      onDayPress={onSelectDate}
      onMonthChange={onMonthChange}
      theme={{
        // 설치 버전의 header 구현이 지원하는 요일별 스타일 키.
        ...{
          "stylesheet.calendar.header": {
            week: {
              marginTop: 15,
              flexDirection: "row",
              justifyContent: "space-around",
            },
            dayTextAtIndex0: { color: theme.destructive },
            dayTextAtIndex6: { color: saturdayColor },
          },
        },
        calendarBackground: theme.background,
        dayTextColor: theme.text,
        textDayFontSize: 14,
        textDayFontWeight: "400",
        monthTextColor: theme.text,
        textMonthFontSize: 18,
        textMonthFontWeight: "700",
        textSectionTitleColor: theme.textSecondary,
        textDisabledColor: `${theme.textSecondary}80`,
        arrowColor: theme.textSecondary,
        selectedDayBackgroundColor: theme.primary,
        selectedDayTextColor: theme.primaryForeground,
        todayTextColor: theme.primary,
        todayBackgroundColor: theme.primaryMuted,
        dotColor: theme.primary,
        todayDotColor: theme.primary,
        selectedDotColor: theme.primaryForeground,
        dotStyle: styles.dot,
        weekVerticalMargin: Spacing.two,
      }}
    />
  );
}

const styles = StyleSheet.create({
  arrowFallback: {
    width: 16,
    height: 16,
    fontSize: 16,
    lineHeight: 16,
    textAlign: "center",
  },
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  header: {
    marginBottom: Spacing.two,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
});
