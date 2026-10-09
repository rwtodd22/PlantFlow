import {useEffect,useRef,useState} from "react";
const localDateValue=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;};
export function CalendarDatePicker({ value, onChange, min, name }: { value: string; onChange: (value: string) => void; min?: string; name?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const parsedDate = new Date(`${value}T12:00:00`);
  const selectedDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  const toValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(gridStart); day.setDate(gridStart.getDate()+index); return day; });
  const moveMonth = (amount: number) => setViewMonth(current => new Date(current.getFullYear(), current.getMonth()+amount, 1));
  const displayDate = selectedDate.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  return <div className="calendar-field" ref={rootRef} onKeyDown={event=>{if(event.key==="Escape"&&open){event.preventDefault();event.stopPropagation();close();}}}>
    {name&&<input type="hidden" name={name} value={value}/>} 
    <button type="button" ref={triggerRef} className={`calendar-trigger ${open?"open":""}`} aria-expanded={open} aria-haspopup="dialog" onClick={()=>{setViewMonth(new Date(selectedDate.getFullYear(),selectedDate.getMonth(),1));setOpen(current=>!current)}}><span>{displayDate}</span><b aria-hidden="true">▦</b></button>
    {open&&<div className="calendar-popover" role="dialog" aria-label="Choose production due date">
      <div className="calendar-caption">Production due date</div><div className="calendar-head"><button type="button" aria-label="Previous month" onClick={()=>moveMonth(-1)}>‹</button><strong aria-live="polite">{viewMonth.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</strong><button type="button" aria-label="Next month" onClick={()=>moveMonth(1)}>›</button></div>
      <div className="calendar-weekdays">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day=><span key={day}>{day}</span>)}</div>
      <div className="calendar-days">{days.map(day=>{const dayValue=toValue(day);const outside=day.getMonth()!==viewMonth.getMonth();return <button type="button" key={dayValue} aria-label={day.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric"})} aria-pressed={dayValue===value} disabled={Boolean(min&&dayValue<min)} className={`${outside?"outside ":""}${dayValue===value?"selected ":""}${dayValue===localDateValue()?"today":""}`.trim()} onClick={()=>{onChange(dayValue);close()}}>{day.getDate()}</button>})}</div>
      <div className="calendar-footer"><button type="button" disabled={Boolean(min&&localDateValue()<min)} onClick={()=>{onChange(localDateValue());close();}}>Today</button><button type="button" onClick={close}>Done</button></div>
    </div>}
  </div>;
}
