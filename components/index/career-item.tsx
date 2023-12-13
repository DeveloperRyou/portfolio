interface Props {
  title: string;
  content: string;
  startDate: string;
  endDate: string;
  link?: string;
  underline?: boolean;
}

export default function CareerItem({
  title,
  content,
  startDate,
  endDate,
  link,
  underline,
}: Props) {
  return (
    <div className="mb-2">
      <h2 className="text-2xl">
        <a
          className={`hover:text-sky-600 ${
            underline && "underline decoration-sky-400"
          }`}
          href={link}
          target="_blank"
        >
          {title}
        </a>
        <span className="text-xl">&nbsp;- {content}</span>
      </h2>
      <p className="text-base text-gray-500">
        {startDate} ~ {endDate}
      </p>
    </div>
  );
}
