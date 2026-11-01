import {
  GithubIcon,
  RedditIcon,
  TwitterIcon,
  YoutubeIcon as YouTubeIcon,
} from "@myoxus/icons/react";

export const relatedLinks = [
  {
    icon: <GithubIcon />,
    title: "GitHub",
    link: BUILD_CONFIG.githubUrl,
  },
  {
    icon: <TwitterIcon />,
    title: "X",
    link: BUILD_CONFIG.websiteUrl,
  },
  {
    icon: <YouTubeIcon />,
    title: "YouTube",
    link: BUILD_CONFIG.releaseNotesUrl,
  },
  {
    icon: <RedditIcon />,
    title: "Reddit",
    link: BUILD_CONFIG.communityUrl,
  },
];
